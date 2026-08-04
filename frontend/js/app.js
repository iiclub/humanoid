import { View3D } from './view3d.js';
import { StickView } from './stick.js';
import { travelToAngle } from './jointmath.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const GROUPS = [
  { id: 'right_arm', label: 'Right arm', color: '#3fb6a8' },
  { id: 'left_arm', label: 'Left arm', color: '#e08a4c' },
  { id: 'head', label: 'Head', color: '#7c8cb5' },
];

const MIRROR = {
  right_shoulder_x: 'left_shoulder_x',
  right_shoulder_y: 'left_shoulder_y',
  right_elbow: 'left_elbow',
  right_wrist_z: 'left_wrist_z',
  right_gripper: 'left_gripper',
};

const app = {
  setup: null,
  state: null,
  ws: null,
  view3d: null,
  stick: null,
  sliders: new Map(),
  connected: false,
};

// ------------------------------------------------------------------ transport

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  app.ws = ws;

  ws.onopen = () => { app.connected = true; pushLog('info', 'connected to control server'); };
  ws.onclose = () => {
    app.connected = false;
    pushLog('warn', 'connection lost — retrying in 2 s');
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'hello':
        app.setup = msg.setup;
        app.state = msg.state;
        app.record = msg.record;
        boot(msg.server);
        break;
      case 'record':
        app.record = msg.record;
        renderRecord();
        break;
      case 'pose':
        app.state.pose = msg.pose;
        syncPose({ fromServer: true });
        break;
      case 'drive':
        app.state.drive = msg.drive;
        renderDrive();
        break;
      case 'motor':
        app.state.motor = msg.motor;
        renderMotor();
        break;
      case 'eyes':
        app.state.eyes = msg.eyes;
        renderEyes();
        break;
      case 'devices':
        app.state.devices = msg.devices;
        renderDevices();
        break;
      case 'estop':
        app.state.estop = msg.estop;
        $('#btnEstop').classList.toggle('armed', msg.estop);
        if (msg.estop) motorHeld = 0;   // stop feeding the keep-alive
        break;
      case 'setup':
        app.setup = msg.setup;
        app.view3d?.setSetup(msg.setup);
        app.stick?.setSetup(msg.setup);
        renderSetupTable();
        break;
      case 'log': pushLog(msg.entry.level, msg.entry.msg); break;
      case 'tx': pushLog('tx', `→ ${msg.nodeId} ${msg.ip}  ${msg.text}`); break;
      default: break;
    }
  };
}

function send(payload) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(payload));
}

async function api(path, method = 'GET', body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ------------------------------------------------------------------ bootstrap

function boot(server) {
  $('#robotName').textContent = app.setup.robotName || 'Humanoid';
  $('#serverInfo').textContent = `${server?.ip || location.hostname}:${app.setup.network.httpPort} · udp ${app.setup.network.nodeUdpPort}`;

  if (!app.view3d) {
    app.view3d = new View3D($('#view3d'), app.setup);
    app.stick = new StickView($('#stick'), app.setup);
    wireStaticControls();
  } else {
    app.view3d.setSetup(app.setup);
    app.stick.setSetup(app.setup);
  }

  renderPoseButtons();
  renderJointControls();
  renderSetupTable();
  renderDevices();
  renderDrive();
  renderMotor();
  renderEyes();
  renderRecord();
  syncPose({ fromServer: true });
  $('#btnEstop').classList.toggle('armed', !!app.state.estop);
}

// ------------------------------------------------------------------ joints UI

function jointsOf(group) {
  return app.setup.joints.filter((j) => j.group === group);
}

function renderPoseButtons() {
  const row = $('#poseRow');
  row.innerHTML = '';
  for (const name of Object.keys(app.setup.poses || {})) {
    const b = el('button', 'btn ghost', name.replace(/_/g, ' '));
    b.onclick = () => send({ type: 'pose', name });
    row.appendChild(b);
  }
}

function buildJointRow(joint) {
  const wrap = el('div', 'joint');

  const label = el('div', 'joint-label');
  label.appendChild(el('span', 'name', joint.label));
  const angle = el('span', 'angle', '0°');
  label.appendChild(angle);
  label.appendChild(el('span', 'meta', `${joint.node.replace('_hand', '')} · ${joint.pin} · ch${joint.channel}`));
  wrap.appendChild(label);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = 0; slider.max = 100; slider.step = 1;
  slider.value = app.state.pose[joint.id] ?? 0;
  slider.oninput = () => setJoint(joint.id, Number(slider.value), true);
  wrap.appendChild(slider);

  const quick = el('div', 'quick');
  for (const [text, value] of [[`home (${joint.initial}°)`, 0], ['25 %', 25], ['50 %', 50], ['75 %', 75], ['end', 100]]) {
    const b = el('button', null, text);
    b.onclick = () => { slider.value = value; setJoint(joint.id, value, true); };
    quick.appendChild(b);
  }
  wrap.appendChild(quick);

  app.sliders.set(joint.id, { slider, angle });
  return wrap;
}

function renderJointControls() {
  app.sliders.clear();
  const armHost = $('#armControls');
  const headHost = $('#headControls');
  armHost.innerHTML = '';
  headHost.innerHTML = '';

  for (const g of GROUPS) {
    const list = jointsOf(g.id);
    if (!list.length) continue;

    const box = el('div', 'group');
    const head = el('div', 'group-head');
    const sw = el('span', 'swatch');
    sw.style.background = g.color;
    head.appendChild(sw);
    head.appendChild(el('span', null, g.label));
    head.appendChild(el('span', 'node-tag', app.setup.nodes[list[0].node]?.label || list[0].node));
    box.appendChild(head);

    const body = el('div', 'group-body');
    for (const j of list) body.appendChild(buildJointRow(j));
    box.appendChild(body);

    box.addEventListener('pointerenter', () => highlight(g.id));
    box.addEventListener('pointerleave', () => highlight(null));

    (g.id === 'head' ? headHost : armHost).appendChild(box);
  }
}

function highlight(group) {
  app.view3d?.setHighlight(group);
  app.stick?.setHighlight(group);
}

function setJoint(id, travel, emit) {
  app.state.pose[id] = travel;
  if (emit) send({ type: 'joint', id, travel });

  if ($('#mirror')?.checked && MIRROR[id]) {
    const twin = MIRROR[id];
    app.state.pose[twin] = travel;
    if (emit) send({ type: 'joint', id: twin, travel });
  }
  syncPose({ fromServer: false });
}

function syncPose({ fromServer }) {
  const pose = app.state.pose;
  app.view3d?.setPose(pose);
  app.stick?.setPose(pose);

  for (const [id, ui] of app.sliders) {
    const joint = app.setup.joints.find((j) => j.id === id);
    const t = pose[id] ?? 0;
    if (fromServer && document.activeElement !== ui.slider) ui.slider.value = t;
    ui.angle.textContent = `${travelToAngle(joint, t)}°  (${Math.round(t)} %)`;
  }
  updateHeadPad();
}

// ------------------------------------------------------------------ head pad

function padFactory(padEl, dotEl, onMove, onEnd) {
  let active = false;
  const update = (e) => {
    const r = padEl.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    const y = Math.max(-1, Math.min(1, 1 - ((e.clientY - r.top) / r.height) * 2));
    dotEl.style.left = `${((x + 1) / 2) * 100}%`;
    dotEl.style.top = `${((1 - y) / 2) * 100}%`;
    onMove(x, y);
  };
  padEl.addEventListener('pointerdown', (e) => { active = true; padEl.setPointerCapture(e.pointerId); update(e); });
  padEl.addEventListener('pointermove', (e) => { if (active) update(e); });
  const stop = () => { if (!active) return; active = false; onEnd?.(dotEl); };
  padEl.addEventListener('pointerup', stop);
  padEl.addEventListener('pointercancel', stop);
  return { setDot: (x, y) => { dotEl.style.left = `${((x + 1) / 2) * 100}%`; dotEl.style.top = `${((1 - y) / 2) * 100}%`; } };
}

let headPad;
function updateHeadPad() {
  if (!headPad) return;
  const pan = (app.state.pose.head_pan ?? 50) / 50 - 1;
  const tilt = (app.state.pose.head_tilt ?? 50) / 50 - 1;
  headPad.setDot(pan, tilt);
}

// -------------------------------------------------------------------- eyes UI

/**
 * The animated eyes live on the phone at /face, not on a servo. These controls
 * push display state to the server, which mirrors it to every connected face —
 * so a phone sitting in the robot's head follows this panel.
 */
function eyesSend(patch) { send({ type: 'eyes', eyes: patch }); }

function renderEyes() {
  const out = $('#eyeReadout');
  if (!out) return;
  const e = app.state?.eyes;
  if (!e) return;

  const where = e.look === 0 ? 'centre'
    : `${Math.abs(e.look)}% ${e.look < 0 ? 'left' : 'right'}`;
  out.textContent =
    `${e.swing ? 'swinging' : where} · lids ${e.lids} · ` +
    `${e.auto ? 'idle wander' : 'held'} · ${e.blink === false ? 'no blink' : 'blinking'} · speed ${e.speed}`;

  for (const btn of document.querySelectorAll('[data-eye-look]')) {
    btn.classList.toggle('on', !e.swing && Number(btn.dataset.eyeLook) === e.look);
  }
  for (const btn of document.querySelectorAll('[data-eye-lids]')) {
    btn.classList.toggle('on', btn.dataset.eyeLids === e.lids);
  }
  $('#btnEyeSwing').classList.toggle('on', e.swing);
  $('#btnEyeAuto').classList.toggle('on', e.auto);
  // Lit = blinking. Unlit = lids held still.
  $('#btnEyeBlink').classList.toggle('on', e.blink !== false);
  $('#btnEyeBlink').textContent = e.blink === false ? 'Blinking off' : 'Blinking';

  // Don't fight the user while they are dragging the slider.
  const slider = $('#eyeSpeed');
  if (document.activeElement !== slider) {
    slider.value = e.speed;
    $('#eyeSpeedOut').textContent = e.speed;
  }
}

function wireSequence() {
  const secs = $('#wakeSecs');
  const show = () => { $('#wakeSecsOut').textContent = `${secs.value} s`; };
  secs.oninput = show;
  show();

  $('#btnWakeSeq').onclick = () =>
    send({ type: 'sequence', action: 'wake', options: { durationMs: Number(secs.value) * 1000 } });
  $('#btnWakeStop').onclick = () => send({ type: 'sequence', action: 'stop' });
}

function wireEyes() {
  for (const btn of document.querySelectorAll('[data-eye-look]')) {
    btn.onclick = () => eyesSend({ look: Number(btn.dataset.eyeLook), swing: false });
  }
  for (const btn of document.querySelectorAll('[data-eye-lids]')) {
    btn.onclick = () => eyesSend({ lids: btn.dataset.eyeLids });
  }
  $('#btnEyeSwing').onclick = () => eyesSend({ swing: !(app.state?.eyes?.swing) });
  $('#btnEyeAuto').onclick = () => eyesSend({ auto: !(app.state?.eyes?.auto), swing: false });
  $('#btnEyeBlink').onclick = () => eyesSend({ blink: app.state?.eyes?.blink === false });

  const slider = $('#eyeSpeed');
  slider.oninput = () => {
    $('#eyeSpeedOut').textContent = slider.value;
    eyesSend({ speed: Number(slider.value) });
  };
}

// ------------------------------------------------------------------ drive UI

let driveHeld = null;

function driveCmd(cmd) {
  const speed = Number($('#speed').value);
  send({ type: 'drive', cmd, speed });
}

function renderDrive() {
  const d = app.state?.drive || { left: 0, right: 0 };
  $('#driveReadout').textContent = `L ${d.left} · R ${d.right}   [${d.cmd || 'stop'}]`;
  app.view3d?.setDrive(d);
}

function wireDrive() {
  for (const btn of document.querySelectorAll('[data-drive]')) {
    const cmd = btn.dataset.drive;
    const press = (e) => {
      e.preventDefault();
      btn.classList.add('pressed');
      driveHeld = cmd;
      driveCmd(cmd);
    };
    const release = () => {
      btn.classList.remove('pressed');
      if (driveHeld === cmd) { driveHeld = null; if (cmd !== 'stop') driveCmd('stop'); }
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('pointercancel', release);
  }

  // keep-alive: the firmware stops on its own if commands go quiet
  setInterval(() => { if (driveHeld && driveHeld !== 'stop') driveCmd(driveHeld); }, 250);

  $('#speed').oninput = (e) => { $('#speedOut').textContent = e.target.value; };

  const pad = padFactory($('#drivePad'), $('#driveDot'),
    (x, y) => send({ type: 'drive', x, y, scale: Number($('#speed').value) / (app.setup.drive.maxPwm || 1023) }),
    (dot) => { dot.style.left = '50%'; dot.style.top = '50%'; send({ type: 'drive', cmd: 'stop' }); });

  const KEYS = { w: 'forward', s: 'reverse', a: 'left', d: 'right', arrowup: 'forward', arrowdown: 'reverse', arrowleft: 'left', arrowright: 'right' };
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === ' ') { driveHeld = null; driveCmd('stop'); return; }
    const cmd = KEYS[k];
    if (cmd) { driveHeld = cmd; driveCmd(cmd); }
  });
  window.addEventListener('keyup', (e) => {
    const cmd = KEYS[e.key.toLowerCase()];
    if (cmd && driveHeld === cmd) { driveHeld = null; driveCmd('stop'); }
  });
  return pad;
}

// ------------------------------------------------------------------ motor UI

/**
 * Aux motor on the right-hand board: an L298N driven by direction alone, so
 * there is nothing to send but a sign. Hold-to-run like the drive pad — press
 * turns, release stops — and a 250 ms keep-alive feeds the firmware failsafe.
 */
let motorHeld = 0;

function motorSend(dir) { send({ type: 'motor', dir }); }

function renderMotor() {
  const out = $('#motorReadout');
  if (!out || !app.setup) return;

  const cfg = app.setup.motor;
  const tab = document.querySelector('.tab[data-tab="motor"]');
  if (tab) tab.hidden = !cfg;
  if (!cfg) return;

  $('#motorPins').textContent =
    `${cfg.label} — L298N on the ${cfg.node} NodeMCU: IN1 ${cfg.pinCw} turns it clockwise, ` +
    `IN2 ${cfg.pinCcw} turns it anticlockwise.`;

  const m = app.state?.motor || { dir: 0, cmd: 'stop' };
  out.textContent = m.dir > 0 ? `▲ up · clockwise · ${cfg.pinCw} HIGH`
    : m.dir < 0 ? `▼ down · anticlockwise · ${cfg.pinCcw} HIGH`
    : m.cmd === 'estop' ? 'blocked by E-STOP' : 'stopped · both pins LOW';

  // The server's view drives the button state, so a command from a tablet shows
  // up here too. Local press feedback is the :active rule in the stylesheet.
  for (const btn of document.querySelectorAll('[data-motor]')) {
    btn.classList.toggle('pressed', m.dir === (btn.dataset.motor === 'up' ? 1 : -1));
  }
}

function wireMotor() {
  for (const btn of document.querySelectorAll('[data-motor]')) {
    const dir = btn.dataset.motor === 'up' ? 1 : -1;
    const press = (e) => { e.preventDefault(); motorHeld = dir; motorSend(dir); };
    const release = () => { if (motorHeld === dir) { motorHeld = 0; motorSend(0); } };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('pointercancel', release);
  }

  // Losing the window mid-press must not leave it turning.
  window.addEventListener('blur', () => { if (motorHeld) { motorHeld = 0; motorSend(0); } });

  setInterval(() => { if (motorHeld) motorSend(motorHeld); }, 250);
}

// ------------------------------------------------------------------ devices

function renderDevices() {
  const host = $('#deviceList');
  const strip = $('#statusStrip');
  if (!host || !app.state?.devices) return;
  host.innerHTML = '';
  strip.innerHTML = '';

  for (const dev of app.state.devices) {
    const cfg = app.setup.nodes[dev.id] || {};

    const pill = el('div', `status-pill ${dev.online ? 'online' : ''}`);
    pill.appendChild(el('span', 'dot'));
    pill.appendChild(el('span', null, `${dev.id} ${dev.ip || '—'}`));
    strip.appendChild(pill);

    const card = el('div', `device ${dev.online ? 'online' : 'offline'}`);
    const top = el('div', 'device-top');
    top.appendChild(el('span', 'dot'));
    top.appendChild(el('span', 'name', dev.label || dev.id));
    top.appendChild(el('span', 'tag', dev.online ? 'online' : 'offline'));
    card.appendChild(top);

    const grid = el('div', 'device-grid');
    const rows = [
      ['ip', dev.ip || '—'],
      ['rssi', dev.rssi != null ? `${dev.rssi} dBm` : '—'],
      ['ap ssid', cfg.apSsid || '—'],
      ['fw', dev.fw || '—'],
      ['pkts out', dev.packetsOut ?? 0],
      ['last seen', dev.lastSeen ? `${Math.round((Date.now() - dev.lastSeen) / 1000)} s ago` : 'never'],
    ];
    for (const [k, v] of rows) {
      const cell = el('div');
      cell.append(`${k}: `);
      cell.appendChild(el('b', null, String(v)));
      grid.appendChild(cell);
    }
    card.appendChild(grid);

    const actions = el('div', 'btn-row');
    const resync = el('button', 'btn ghost', 'Re-send pose');
    resync.onclick = () => api(`/devices/${dev.id}/resync`, 'POST');
    actions.appendChild(resync);

    const setIp = el('button', 'btn ghost', 'Set IP manually');
    setIp.onclick = async () => {
      const ip = prompt(`IP address for ${dev.label || dev.id}`, dev.ip || '192.168.1.');
      if (ip) await api(`/devices/${dev.id}/ip`, 'POST', { ip });
    };
    actions.appendChild(setIp);
    card.appendChild(actions);

    host.appendChild(card);
  }
}

// ------------------------------------------------------------------ setup UI

function renderSetupTable() {
  const host = $('#setupTable');
  if (!host) return;
  host.innerHTML = '';

  for (const j of app.setup.joints) {
    const row = el('div', 'setup-row');

    const rid = el('div', 'rid');
    rid.appendChild(el('span', null, j.label));
    rid.appendChild(el('small', null, `${j.node} · ${j.pin} · ch${j.channel}`));
    row.appendChild(rid);

    const dir = el('button', `toggle ${j.direction === 1 ? 'pos' : 'neg'}`, `dir ${j.direction > 0 ? '+1' : '-1'}`);
    dir.onclick = async () => {
      await api(`/setup/joints/${j.id}`, 'PATCH', { direction: j.direction === 1 ? -1 : 1 });
    };
    row.appendChild(dir);

    const init = el('button', 'toggle', `init ${j.initial}°`);
    init.onclick = async () => {
      await api(`/setup/joints/${j.id}`, 'PATCH', { initial: j.initial === j.min ? j.max : j.min });
    };
    row.appendChild(init);

    const trim = document.createElement('input');
    trim.type = 'number';
    trim.value = j.trim || 0;
    trim.min = -30; trim.max = 30; trim.step = 1;
    trim.title = 'trim (degrees)';
    trim.onchange = () => api(`/setup/joints/${j.id}`, 'PATCH', { trim: Number(trim.value) });
    row.appendChild(trim);

    host.appendChild(row);
  }
}

// ------------------------------------------------------------------ record

function fmtDur(ms) {
  const s = (ms || 0) / 1000;
  return s < 1 ? `${Math.round(ms)} ms` : `${s.toFixed(1)} s`;
}

function recSend(action, extra = {}) { send({ type: 'record', action, ...extra }); }

function renderRecord() {
  const r = app.record;
  if (!r) return;

  const status = $('#recStatus');
  const stateText = $('#recStateText');
  const meta = $('#recMeta');
  const dot = $('#recDot');
  if (!status) return;

  status.classList.toggle('recording', r.recording);
  status.classList.toggle('playing', r.playing);

  if (r.recording) stateText.textContent = 'recording…';
  else if (r.playing) stateText.textContent = r.loop ? `playing (loop ${r.loopCount})` : 'playing';
  else stateText.textContent = r.frames ? 'ready' : 'idle';

  meta.textContent = `${r.frames} frames · ${fmtDur(r.duration)}${r.name ? ` · ${r.name}` : ''}`;

  $('#btnRec').disabled = r.recording || r.playing;
  $('#btnRecStop').disabled = !r.recording;
  $('#btnPlay').disabled = r.recording || r.playing || !r.frames;
  $('#btnPlayStop').disabled = !r.playing;
  $('#btnSaveRec').disabled = r.recording || !r.frames;
  $('#loopChk').checked = r.loop;

  // topbar badge, visible from any tab
  const badge = $('#recBadge');
  if (r.recording) { badge.hidden = false; badge.className = 'rec-badge'; badge.textContent = 'REC'; }
  else if (r.playing) { badge.hidden = false; badge.className = 'rec-badge playing'; badge.textContent = r.loop ? 'LOOP' : 'PLAY'; }
  else badge.hidden = true;

  const list = $('#savedList');
  list.innerHTML = '';
  if (!r.saved.length) {
    list.appendChild(el('div', 'saved-empty', 'No saved routines yet — record something and hit Save.'));
  }
  for (const take of r.saved) {
    const item = el('div', 'saved-item');
    const info = el('div');
    info.appendChild(el('div', 's-name', take.name));
    info.appendChild(el('div', 's-meta', `${take.frames} frames · ${fmtDur(take.duration)}`));
    item.appendChild(info);

    const actions = el('div', 's-actions');
    const load = el('button', 'btn ghost', 'Load');
    load.onclick = () => recSend('load', { name: take.name });
    const playIt = el('button', 'btn', '► Loop');
    playIt.onclick = () => { recSend('load', { name: take.name }); setTimeout(() => recSend('play', { loop: true }), 120); };
    const del = el('button', 'btn ghost', '✕');
    del.title = 'delete';
    del.onclick = () => recSend('remove', { name: take.name });
    actions.append(load, playIt, del);
    item.appendChild(actions);
    list.appendChild(item);
  }
}

function wireRecord() {
  $('#btnRec').onclick = () => recSend('start');
  $('#btnRecStop').onclick = () => recSend('stop');
  $('#btnPlay').onclick = () => recSend('play', { loop: $('#loopChk').checked });
  $('#btnPlayStop').onclick = () => recSend('stopplay');
  $('#loopChk').onchange = (e) => {
    // toggling mid-playback restarts with the new loop flag
    if (app.record?.playing) recSend('play', { loop: e.target.checked });
  };
  $('#btnSaveRec').onclick = () => {
    const name = $('#recName').value.trim() || `take-${Date.now().toString().slice(-5)}`;
    recSend('save', { name });
    $('#recName').value = '';
  };
  $('#recName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnSaveRec').click(); });
}

// ------------------------------------------------------------------ logging

function pushLog(level, msg) {
  const host = $('#log');
  if (!host) return;
  const line = el('div', `l-${level}`, `${new Date().toLocaleTimeString()}  ${msg}`);
  host.appendChild(line);
  while (host.childElementCount > 220) host.removeChild(host.firstChild);
  host.scrollTop = host.scrollHeight;
}

// ------------------------------------------------------------------ wiring

function wireStaticControls() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('active', p.dataset.page === tab.dataset.tab));
    };
  }

  $('#btnSpin').onclick = (e) => e.target.classList.toggle('on', app.view3d.toggleSpin());
  $('#btnSpin').classList.add('on');
  $('#btnResetView').onclick = () => app.view3d.resetView();
  $('#btnHome').onclick = () => send({ type: 'home' });
  $('#btnEstop').onclick = () => send({ type: 'estop', on: !app.state.estop });
  $('#btnAnnounce').onclick = () => api('/announce', 'POST');
  $('#btnResyncAll').onclick = () => { for (const d of app.state.devices) api(`/devices/${d.id}/resync`, 'POST'); };
  $('#btnHeadCenter').onclick = () => { setJoint('head_pan', 50, true); setJoint('head_tilt', 50, true); };

  $('#btnDownloadSetup').onclick = () => {
    const blob = new Blob([JSON.stringify(app.setup, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'setup.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  headPad = padFactory($('#headPad'), $('#headDot'), (x, y) => {
    setJoint('head_pan', Math.round((x + 1) * 50), true);
    setJoint('head_tilt', Math.round((y + 1) * 50), true);
  });

  wireDrive();
  wireMotor();
  wireEyes();
  wireSequence();
  wireRecord();
  setInterval(renderDevices, 2000);
}

connect();
