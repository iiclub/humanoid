import { View3D } from './view3d.js';
import { StickView } from './stick.js';
import { travelToAngle } from './jointmath.js';
import * as choreo from './choreo.js';

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
        app.actions = msg.actions || [];
        app.action = msg.action || { playing: false };
        app.audioFile = msg.audioFile || null;
        app.audioStamp = msg.audioStamp || 0;
        app.live = !!msg.live;
        app.voiceAgent = !!msg.voiceAgent;
        boot(msg.server);
        break;
      case 'action':
        app.action = msg.action;
        // The music belongs to the routine, not to the button that started it:
        // E-STOP, ■ Stop, or another routine taking over all end up here.
        if (!msg.action?.playing) music.autoStop();
        renderActions();
        renderDances();
        break;
      case 'live':
        app.live = !!msg.on;
        renderLive();
        break;
      case 'voiceagent':
        app.voiceAgent = !!msg.on;
        renderAgent();
        break;
      // Somebody pressed reload after editing actions.json / dances.json.
      case 'actions':
        app.actions = msg.actions || [];
        app.action = msg.action || { playing: false };
        app.audioFile = msg.audioFile || app.audioFile;
        /* A changed stamp means a file on disk was replaced, so the elements
           holding the old bytes have to go — the URL alone changing is not
           enough once an element has already buffered. */
        if (msg.audioStamp && msg.audioStamp !== app.audioStamp) {
          app.audioStamp = msg.audioStamp;
          music.dropAll();
        }
        renderActions({ rebuild: true });
        renderDances({ rebuild: true });
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
        // The server hit the run cap on its own — stop feeding the keep-alive.
        if (msg.motor.cmd === 'capped') { motorHeld = 0; motorAuto = 0; }
        renderMotor();
        break;
      case 'light':
        app.state.light = msg.light;
        renderLight();
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
        if (msg.estop) music.stop();       // never held by the press guard
        $('#btnEstop').classList.toggle('armed', msg.estop);
        if (msg.estop) motorRelease(false);   // stop feeding the keep-alive
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
  renderActions();
  renderDances();
  renderLive();
  renderAgent();
  renderJointControls();
  renderSetupTable();
  renderDevices();
  renderDrive();
  renderMotor();
  renderLight();
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

/* The head tilts only, so it gets a plain slider rather than an X/Y pad. This
   mirrors the server's view back into it — a nudge from a tablet moves the
   slider here too. */
function updateHeadPad() {
  const slider = $('#headTilt');
  if (!slider) return;
  const travel = Math.round(app.state.pose.head_tilt ?? 50);
  if (document.activeElement !== slider) slider.value = travel;
  const out = $('#headTiltOut');
  if (out) out.textContent = `${travel} %`;
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
    `${e.auto ? 'idle wander' : 'held'} · ${e.blink === false ? 'no blink' : 'blinking'} · speed ${e.speed}` +
    (e.fx === 'dj' ? ` · DJ @ ${e.bpm} BPM` : '');

  // The dance panel's copy of the same state.
  $('#btnDjOn')?.classList.toggle('on', e.fx === 'dj');
  $('#btnDjOff')?.classList.toggle('on', e.fx !== 'dj');
  const bpm = $('#djBpm');
  if (bpm && e.bpm != null && document.activeElement !== bpm) {
    bpm.value = e.bpm;
    $('#djBpmOut').textContent = `${e.bpm} BPM`;
  }

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
  $('#btnAgent')?.addEventListener('click', () => send({ type: 'voiceagent', on: !app.voiceAgent }));
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

// ------------------------------------------------------------------ torso UI

/**
 * Torso lift on the right-hand board: an L298N driven by direction alone, so
 * there is nothing to send but a sign. Hold-to-run like the drive pad, with a
 * 250 ms keep-alive feeding the firmware failsafe.
 *
 * The two buttons are deliberately not symmetric:
 *
 *   Torso up    lifts while held, and on release drives back DOWN by itself
 *               until the run cap stops it.
 *   Torso down  lowers while held and simply stops on release.
 *
 * Nothing here is a safety mechanism. The firmware caps every run on its own
 * and stops when commands go quiet; this side just stops asking at the same
 * moment, so the readout matches what the motor is actually doing.
 */
let motorHeld = 0;         // direction the user is holding, 0 if nothing
let motorAuto = 0;         // direction of an unattended auto-lower, 0 if none
let motorAutoUntil = 0;

function motorSend(dir) { send({ type: 'motor', dir }); }

function motorRunCapMs() { return app.setup?.motor?.maxRunMs || 4000; }

/** Stop everything, held or automatic. */
function motorRelease(sendStop = true) {
  const wasMoving = motorHeld || motorAuto;
  motorHeld = 0;
  motorAuto = 0;
  motorAutoUntil = 0;
  if (wasMoving && sendStop) motorSend(0);
}

/** Let go of "up" -> lower back down, unattended, until the cap. */
function motorStartAutoLower() {
  motorHeld = 0;
  motorAuto = -1;
  motorAutoUntil = Date.now() + motorRunCapMs();
  motorSend(-1);
}

function renderMotor() {
  const out = $('#motorReadout');
  if (!out || !app.setup) return;

  const cfg = app.setup.motor;
  const tab = document.querySelector('.tab[data-tab="motor"]');
  // The tab carries the light too, so it survives a setup with no motor at all.
  if (tab) tab.hidden = !cfg && !app.setup.light;
  for (const n of [$('#motorPins'), document.querySelector('.motor-pad'), out]) {
    if (n) n.hidden = !cfg;
  }
  if (!cfg) return;

  const cap = motorRunCapMs();
  $('#motorPins').textContent =
    `${cfg.label} — L298N on the ${cfg.node} NodeMCU: IN1 ${cfg.pinUp} lifts, ` +
    `IN2 ${cfg.pinDown} lowers` +
    (cfg.pinEn ? `, enable on ${cfg.pinEn}` : '') + '.';
  const capText = $('#motorCapText');
  if (capText) capText.textContent = `${(cap / 1000).toFixed(cap % 1000 ? 1 : 0)} s`;

  const m = app.state?.motor || { dir: 0, cmd: 'stop' };
  out.textContent = m.dir > 0 ? `▲ lifting · ${cfg.pinUp} HIGH${cfg.pinEn ? ` · ${cfg.pinEn} HIGH` : ''}`
    : m.dir < 0 ? `▼ lowering${motorAuto ? ' (auto)' : ''} · ${cfg.pinDown} HIGH${cfg.pinEn ? ` · ${cfg.pinEn} HIGH` : ''}`
    : m.cmd === 'estop' ? 'blocked by E-STOP'
    : m.cmd === 'capped' ? `stopped at the ${(cap / 1000).toFixed(0)} s cap · let go and press again`
    : 'stopped · all pins LOW';

  // The server's view drives the button state, so a command from a tablet shows
  // up here too. Local press feedback is the :active rule in the stylesheet.
  for (const btn of document.querySelectorAll('[data-motor]')) {
    btn.classList.toggle('pressed', m.dir === (btn.dataset.motor === 'up' ? 1 : -1));
  }
}

function wireMotor() {
  for (const btn of document.querySelectorAll('[data-motor]')) {
    const dir = btn.dataset.motor === 'up' ? 1 : -1;

    const press = (e) => {
      e.preventDefault();
      motorAuto = 0;                 // a new press always wins over an auto-lower
      motorAutoUntil = 0;
      motorHeld = dir;
      motorSend(dir);
    };
    const release = () => {
      if (motorHeld !== dir) return;
      if (dir > 0) motorStartAutoLower();   // let go of "up" -> it comes back down
      else motorRelease();
    };

    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('pointercancel', release);
  }

  /* Losing the window mid-press must not leave it running. The auto-lower is
     dropped rather than carried on in the background: the firmware is already
     holding a failsafe under it, and a hidden tab is no place to be driving a
     motor from. */
  window.addEventListener('blur', () => motorRelease());
  document.addEventListener('visibilitychange', () => { if (document.hidden) motorRelease(); });

  setInterval(() => {
    if (motorHeld) { motorSend(motorHeld); return; }
    if (!motorAuto) return;
    if (Date.now() >= motorAutoUntil) motorRelease();   // cap reached — park it
    else motorSend(motorAuto);
  }, 250);
}

// ------------------------------------------------------------------ light UI

/**
 * The work light. The board owns the animation — it ramps between levels and
 * runs its own three-blink greeting on power-up — so all that goes over the
 * wire is where it should end up.
 */
function lightSend(cmd) { send({ type: 'light', cmd }); }

function renderLight() {
  const out = $('#lightReadout');
  if (!out || !app.setup) return;

  const cfg = app.setup.light;
  const head = $('#lightPins');
  for (const btn of document.querySelectorAll('[data-light]')) btn.hidden = !cfg;
  out.hidden = !cfg;
  if (head) head.hidden = !cfg;
  if (!cfg) return;

  // A switched output has no brightness, so never promise a fade it can't do.
  const dimmable = cfg.pwm !== false;
  if (head) {
    head.textContent = `— ${cfg.pin} on the ${cfg.node} NodeMCU` + (dimmable ? '' : ' (switched — on/off only)');
  }
  const hint = $('#lightHint');
  if (hint) {
    hint.textContent = dimmable
      ? `The board runs the start-up sequence by itself on every power-up — ${cfg.bootBlinks ?? 3} blinks, then a slow `
        + `${(cfg.bootFadeMs || 2500) / 1000} s ramp to full — so the light is already on before the WiFi has finished `
        + 'joining. These buttons ramp it up and down afterwards.'
      : `The board runs the start-up sequence by itself on every power-up — ${cfg.bootBlinks ?? 3} blinks, then it stays on `
        + '— so the light is already lit before the WiFi has finished joining. This output is switched rather than dimmed, '
        + 'so the blinks are the only movement; on and off are instant.';
  }

  const l = app.state?.light || { on: false, cmd: 'off' };
  out.textContent = l.cmd === 'sequence'
    ? `↻ start-up sequence · ${cfg.bootBlinks ?? 3} blinks, then ${dimmable ? `a ${(cfg.bootFadeMs || 2500) / 1000} s ramp to full` : 'on'}`
    : l.on ? `☀ on · ${cfg.pin} HIGH` : `☾ off · ${cfg.pin} LOW`;

  for (const btn of document.querySelectorAll('[data-light]')) {
    const active = btn.dataset.light === (l.on ? 'on' : 'off') && l.cmd !== 'sequence';
    btn.classList.toggle('pressed', active);
  }
}

function wireLight() {
  for (const btn of document.querySelectorAll('[data-light]')) {
    btn.addEventListener('click', () => lightSend(btn.dataset.light));
  }
}

// ----------------------------------------------------------------- actions

/**
 * Named gestures. The buttons and the mic both end up here — the voice path
 * resolves a phrase to an action id on the server and the server runs it, so
 * there is exactly one way a gesture ever gets played.
 */
function renderActions({ rebuild = false } = {}) {
  const list = (app.actions || []).filter((a) => a.kind !== 'dance');
  fillActionGrid($('#actionGrid'), list, rebuild);
  paintActionStatus($('#actionStatus'), $('#actionStatusText'), $('#actionGrid'), 'action');
}

/**
 * Choreography. Same catalogue, same player, same one-thing-at-a-time rule —
 * the server tags dances so they can have their own page without becoming a
 * second engine that fights the first over the same shoulder.
 */
function renderDances({ rebuild = false } = {}) {
  const list = (app.actions || []).filter((a) => a.kind === 'dance');
  const grid = $('#danceGrid');

  /* Name only. The Actions tab explains itself because you go there to find
     out what a gesture is; you come here with the music already playing and
     you want the name and a big target. The `description` still travels in the
     catalogue — it is what the mic reasons over — it is just not printed. */
  fillActionGrid(grid, list, rebuild, (btn, a) => {
    btn.classList.add('dance-btn');
    if (/drives/i.test(a.label || '')) btn.classList.add('moves');
    wireLongPressRemove(btn, a);          // registered first — see the function
    btn.addEventListener('click', () => music.play(a));
  }, { describe: false });

  paintActionStatus($('#danceStatus'), $('#danceStatusText'), grid, 'dance');
  music.preload(list);

  const sub = $('#danceSub');
  if (sub) sub.textContent = `${list.length} routine${list.length === 1 ? '' : 's'} · config/dances.json`;
}

function fillActionGrid(grid, list, rebuild, decorate, { describe = true } = {}) {
  if (!grid || !app.actions) return;
  if (rebuild) grid.innerHTML = '';
  if (grid.childElementCount) return;

  for (const a of list) {
    const btn = el('button', 'btn action');
    btn.dataset.action = a.id;
    btn.append(el('span', 'a-name', a.label || a.id));
    if (describe && a.description) btn.append(el('span', 'a-desc', a.description));
    decorate?.(btn, a);
    btn.addEventListener('click', () => send({ type: 'action', id: a.id }));
    grid.append(btn);
  }
}

/**
 * Long-press a dance button and it offers to remove itself; tap it again
 * within three seconds and it goes, audio file and all. No confirm() dialog:
 * a modal would freeze the page, and the second tap IS the confirmation.
 *
 * Registered before the run/play listeners on purpose. The click that follows
 * a long-press has to be swallowed, and stopImmediatePropagation() only stops
 * listeners that were added after this one.
 */
function wireLongPressRemove(btn, dance) {
  const HOLD = 650;
  let timer = null;
  let fired = false;
  let disarm = null;

  const arm = () => {
    fired = true;
    btn.classList.add('armed');
    btn.querySelector('.a-name').textContent = `✕ remove "${dance.label}"?`;
    clearTimeout(disarm);
    disarm = setTimeout(reset, 3000);
  };
  const reset = () => {
    btn.classList.remove('armed');
    btn.querySelector('.a-name').textContent = dance.label || dance.id;
  };

  btn.addEventListener('pointerdown', () => { fired = false; timer = setTimeout(arm, HOLD); });
  btn.addEventListener('pointerup', () => clearTimeout(timer));
  btn.addEventListener('pointercancel', () => clearTimeout(timer));
  btn.addEventListener('pointerleave', () => clearTimeout(timer));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  btn.addEventListener('click', async (e) => {
    if (fired) {                          // the click that ends the long-press
      fired = false;
      e.stopImmediatePropagation();
      return;
    }
    if (!btn.classList.contains('armed')) return;
    e.stopImmediatePropagation();
    clearTimeout(disarm);
    btn.disabled = true;
    const res = await api(`/dances/${dance.id}`, 'DELETE');
    danceSay(res.ok ? `removed "${dance.label}"` : `could not remove: ${res.error}`);
    // The server broadcasts the new catalogue, which rebuilds this grid.
    if (!res.ok) { btn.disabled = false; reset(); }
  });
}

// --------------------------------------------------------------- the music

/**
 * The bit of the track a routine dances to.
 *
 * One <audio> element per file, built when the catalogue arrives rather than
 * on the first press: seeking an already-loaded element is instant, where a
 * fresh one per press would re-fetch and hand you a quarter second of the
 * robot dancing to silence. The end of a clip is policed by `timeupdate`
 * rather than a setTimeout, because a timer measures wall clock and the only
 * thing that matters is where the playhead actually got to.
 *
 * It plays on whichever device pressed the button — that is the one near the
 * speaker. `enabled` is for when the track is already coming out of a PA and
 * a second copy half a beat behind it is the last thing anybody needs.
 */
const music = {
  enabled: true,
  elements: new Map(),     // file -> HTMLAudioElement
  current: null,
  until: 0,
  gen: 0,                  // bumped per play/stop; stale promises check it
  guardUntil: 0,           // see autoStop()

  fileFor(dance) {
    return (dance?.audio && dance.audio.file) || app.audioFile || 'audio/dakait-beat.mp3';
  },

  element(file) {
    let a = this.elements.get(file);
    if (!a) {
      a = new Audio(`${file}?v=${app.audioStamp || 0}`);
      a.preload = 'auto';
      a.addEventListener('timeupdate', () => {
        if (a === this.current && this.until && a.currentTime >= this.until) this.stop();
      });
      a.addEventListener('error', () => danceSay(`no music at frontend/${file} — the robot dances anyway`));
      this.elements.set(file, a);
    }
    return a;
  },

  /* Called with the dance list whenever the catalogue changes. Elements for
     files that are no longer referenced are dropped; a re-imported file gets
     a fresh element with a fresh cache-buster, otherwise the browser would
     happily serve the copy it fetched before the upload. */
  preload(dances) {
    const want = new Set(dances.map((d) => this.fileFor(d)));
    for (const [file, a] of this.elements) {
      if (!want.has(file)) { a.pause(); this.elements.delete(file); }
    }
    for (const file of want) this.element(file);
  },

  /** Throw every cached element away; the next play rebuilds at the new stamp. */
  dropAll() {
    for (const a of this.elements.values()) a.pause();
    this.elements.clear();
    this.current = null;
  },

  play(dance) {
    if (!this.enabled || !dance?.audio) return;
    const { start = 0, end = 0 } = dance.audio;
    const a = this.element(this.fileFor(dance));
    if (this.current && this.current !== a) this.current.pause();
    this.current = a;
    this.until = end;

    const token = ++this.gen;
    /* Starting a routine makes the server stop whatever was playing FIRST, so
       a `playing: false` is always in flight a few milliseconds behind this
       press. Without a guard it arrives, pauses the clip that was just
       started, and the second dance you press runs in silence. */
    this.guardUntil = Date.now() + 900;

    try {
      a.currentTime = start;
      /* Autoplay is blocked without a user gesture, which is exactly what a
         button press is — but the promise still rejects if the file is
         missing, and an unhandled rejection here would be invisible. */
      a.play().then(
        () => { if (token === this.gen) danceSay(`♪ ${dance.label} — ${start.toFixed(1)}s to ${end.toFixed(1)}s`); },
        (err) => {
          /* AbortError is what an interrupted play() looks like — something
             newer took over. That is not a failure and not worth a line of
             text; a stale token means the same thing. */
          if (err.name === 'AbortError' || token !== this.gen) return;
          danceSay(/source/i.test(err.message) ? this.missing() : `clip: ${err.message}`);
        });
    } catch (err) {
      danceSay(`could not seek to ${start}s: ${err.message}`);
    }
  },

  /**
   * Stop requested by the player's own status, rather than by a person.
   *
   * The server stops the running routine before starting the next one, so
   * every press produces a `playing: false` immediately followed by a
   * `playing: true`. Acting on the first would silence the clip that press
   * just started. A press is therefore given a moment to survive its own stop
   * message; ■ Stop and E-STOP call stop() directly and are never held.
   */
  autoStop() {
    if (Date.now() < this.guardUntil) return;
    this.stop();
  },

  stop() {
    this.until = 0;
    this.gen++;                 // any play() promise still in flight is stale
    this.guardUntil = 0;
    if (this.current) this.current.pause();
  },
};

function danceSay(text) {
  const out = $('#danceReadout');
  if (out) out.textContent = text;
}

/* Both pages watch the same player, so a dance started from the mic lights up
   here and a gesture started here shows on the dance page's status line too. */
function paintActionStatus(box, text, grid, kind) {
  const st = app.action || { playing: false };
  const mine = st.playing && (st.action?.kind || 'action') === kind;

  if (box) {
    box.hidden = !st.playing;
    if (text && st.playing) {
      const where = mine ? '' : ' (from the other tab)';
      text.textContent = `${st.action?.label || st.action?.id} — step ${st.step} of ${st.steps}${where}`;
    }
  }
  for (const btn of grid?.querySelectorAll('[data-action]') || []) {
    btn.classList.toggle('running', st.playing && st.action?.id === btn.dataset.action);
  }
}

// -------------------------------------------------------------- dance panel

/**
 * DJ mode and the beat it runs at are ordinary eye state: they go to the
 * server and come back to every connected face, which is the only reason a
 * panel on a laptop can light up a phone wedged in the robot's head.
 */
function wireDance() {
  $('#btnDanceStop')?.addEventListener('click', () => { music.stop(); send({ type: 'action', command: 'stop' }); });

  /* Live dance. This button carries only the intent — the listening, the beat
     tracking and the poses all happen on the phone at /face, which is the
     device with a microphone pointed at the room. The server relays the flag
     and the phone acts on it. */
  $('#btnLive')?.addEventListener('click', () => {
    music.stop();
    send({ type: 'live', on: !app.live });
    danceSay(app.live ? 'stopping live dance…' : 'asking the phone at /face to listen…');
  });
  renderLive();

  const mute = $('#btnMusic');
  mute?.addEventListener('click', () => {
    music.enabled = !music.enabled;
    if (!music.enabled) music.stop();
    mute.classList.toggle('on', music.enabled);
    mute.textContent = music.enabled ? '🔊 Music on' : '🔇 Music off';
    danceSay(music.enabled ? 'clips play from this device' : 'silent — run the track yourself');
  });
  mute?.classList.add('on');

  /* Import. Two kinds of file and nothing else: an .mp3 opens the trim-and-
     create panel, a .json is a routine written by hand (or exported from
     another robot) and goes straight in. The accept attribute is a hint to
     the picker, not a check — the extension is tested here. */
  const picker = $('#importFile');
  $('#btnImport')?.addEventListener('click', () => picker.click());
  picker?.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';                     // so picking the same file twice re-fires
    if (file) importFile(file);
  });

  wireCreatePanel();

  const bpm = $('#djBpm');
  const showBpm = () => { $('#djBpmOut').textContent = `${bpm.value} BPM`; };

  $('#btnDjOn')?.addEventListener('click', () => eyesSend({ fx: 'dj', bpm: Number(bpm.value) }));
  $('#btnDjOff')?.addEventListener('click', () =>
    eyesSend({ fx: 'none', look: 0, swing: false, auto: true, blink: true }));

  bpm?.addEventListener('input', showBpm);
  bpm?.addEventListener('change', () => eyesSend({ bpm: Number(bpm.value) }));
  showBpm();

  /* Tap tempo. Averaging the gaps beats using only the last one — a single
     late tap would otherwise throw the whole beat. Four taps is enough to be
     steady and short enough that nobody gives up half way. */
  let taps = [];
  $('#btnDjBeat')?.addEventListener('click', () => {
    const now = Date.now();
    if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];   // new attempt
    taps.push(now);
    if (taps.length > 5) taps.shift();
    if (taps.length < 2) { danceSay('keep tapping…'); return; }

    const span = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    const value = Math.max(40, Math.min(200, Math.round(60000 / span)));
    bpm.value = value;
    showBpm();
    eyesSend({ bpm: value });
    danceSay(`${value} BPM from ${taps.length} taps · one beat = ${Math.round(60000 / value)} ms`);
  });

  $('#btnDanceReload')?.addEventListener('click', async () => {
    danceSay('reloading…');
    const res = await api('/actions/reload', 'POST');
    danceSay(res.ok
      ? `reloaded — ${res.actions.filter((a) => a.kind === 'dance').length} routines, ${res.actions.length} entries total`
      : `dances.json rejected: ${res.error} (the old set is still loaded)`);
  });

  $('#btnDanceFull')?.addEventListener('click', () => toggleFullscreen($('#dancePage')));
  $('#btnFullscreen')?.addEventListener('click', () => toggleFullscreen(document.documentElement));

  /* A fullscreened tab page is out of the tab strip's reach, so it needs its
     own way back — and the button has to say which way it goes. */
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, () => {
      const fs = fullscreenEl();
      $('#btnDanceFull').textContent = fs === $('#dancePage') ? '✕ Exit full screen' : '⛶ Full screen';
      $('#dancePage')?.classList.toggle('is-full', fs === $('#dancePage'));
    });
  }
}

// ------------------------------------------------------------------ import

async function importFile(file) {
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name) || [, ''])[1].toLowerCase();
  if (ext === 'json') return importJson(file);
  if (ext === 'mp3') return openCreate(file);
  danceSay(`"${file.name}" — only .mp3 and .json are accepted`);
}

/* A routine written by hand, or exported from another robot. One dance
   object, or { dances: [...] } in the shape of config/dances.json. */
async function importJson(file) {
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch (err) { return danceSay(`${file.name} is not valid JSON: ${err.message}`); }

  const list = Array.isArray(parsed?.dances) ? parsed.dances
    : Array.isArray(parsed) ? parsed
    : [parsed];
  const real = list.filter((d) => d && typeof d === 'object');
  if (!real.length) return danceSay(`${file.name} has no routines in it`);

  let added = 0;
  for (const d of real) {
    const res = await api('/dances', 'POST', d);
    if (res.ok) added++;
    else danceSay(`"${d.label || d.id}" rejected: ${res.error}`);
  }
  if (added) danceSay(`imported ${added} routine${added === 1 ? '' : 's'} from ${file.name}`);
}

// ---------------------------------------------------------- create from mp3

/**
 * Import an .mp3 → name it, trim it, press Create. The audio is decoded
 * here, in the browser, because this is the one machine in the system with a
 * decoder: the server is Node with no audio stack and the robot is an
 * ESP8266. choreo.js does the analysis and writes the steps; the file and the
 * routine then go to the server, and the routine comes back to every client
 * in the next catalogue broadcast.
 */
const create = {
  file: null,
  buffer: null,       // AudioBuffer
  mono: null,         // Float32Array
  preview: null,      // HTMLAudioElement on a blob URL, for the trim preview
  url: null,
  busy: false,
  env: null,          // per-pixel RMS envelope, computed once per canvas width
  envWidth: 0,
  raf: 0,             // playhead animation frame while previewing
  drag: null,         // 'start' | 'end' while a handle is being dragged
};

async function openCreate(file) {
  const panel = $('#createPanel');
  if (!panel) return;
  closeCreate();

  create.file = file;
  $('#createSource').textContent = file.name;
  $('#createName').value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 40);
  $('#createResult').textContent = 'decoding…';
  panel.hidden = false;
  panel.scrollIntoView({ block: 'nearest' });

  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    create.buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    ctx.close?.();
  } catch (err) {
    $('#createResult').textContent = `could not decode ${file.name}: ${err.message}`;
    return;
  }

  create.mono = choreo.monoOf(create.buffer);
  const dur = create.buffer.duration;

  const s = $('#trimStart');
  const e = $('#trimEnd');
  s.max = e.max = dur.toFixed(1);
  s.value = 0;
  e.value = Math.min(dur, 60).toFixed(1);     // a minute is plenty of dance

  create.url = URL.createObjectURL(file);
  create.preview = new Audio(create.url);
  /* The preview stops at the trim's end and parks back at its start, so the
     next ▶ plays the same piece again — auditioning a trim is the whole job. */
  create.preview.addEventListener('timeupdate', () => {
    const [a, b] = trimRange();
    if (!create.preview.paused && create.preview.currentTime >= b) {
      create.preview.pause();
      create.preview.currentTime = a;
    }
  });
  create.preview.addEventListener('play', () => { playheadLoop(); paintPlayButtons(); });
  create.preview.addEventListener('pause', () => { cancelAnimationFrame(create.raf); create.raf = 0; drawWave(); paintPlayButtons(); });
  // Seeks are asynchronous: the `pause` repaint above can run before a
  // currentTime assignment has landed, leaving the playhead drawn where it was.
  create.preview.addEventListener('seeked', () => { if (create.preview.paused) drawWave(); });

  create.env = null;
  updateTrim();
  $('#createResult').textContent = `${dur.toFixed(1)} s · ${create.buffer.sampleRate} Hz · tap the wave to listen from there, drag the yellow edges to trim`;
}

function closeCreate() {
  const panel = $('#createPanel');
  if (panel) panel.hidden = true;
  create.preview?.pause();
  cancelAnimationFrame(create.raf);
  if (create.url) URL.revokeObjectURL(create.url);
  Object.assign(create, { file: null, buffer: null, mono: null, preview: null, url: null, busy: false, env: null, envWidth: 0, raf: 0, drag: null });
}

function trimRange() {
  let a = Number($('#trimStart').value);
  let b = Number($('#trimEnd').value);
  if (b - a < 4) b = Math.min(Number($('#trimEnd').max), a + 4);   // analyse() wants four seconds
  return [a, b];
}

function updateTrim() {
  const [a, b] = trimRange();
  $('#trimStartOut').textContent = `${a.toFixed(1)} s`;
  $('#trimEndOut').textContent = `${b.toFixed(1)} s`;
  $('#trimLen').textContent = `${(b - a).toFixed(1)} s selected`;
  drawWave();
}

const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/* Per-pixel RMS, computed once per canvas width. This used to be recomputed
   on every slider tick — a full pass over every sample of the song, several
   million multiplies per pixel-width of drag — which is what made the sliders
   drag their feet on a phone. */
function envelopeFor(width) {
  if (create.env && create.envWidth === width) return create.env;
  const x = create.mono;
  const env = new Float32Array(width);
  const per = x.length / width;
  for (let px = 0; px < width; px++) {
    const i0 = Math.floor(px * per);
    const i1 = Math.floor((px + 1) * per);
    let sq = 0;
    for (let i = i0; i < i1; i++) sq += x[i] * x[i];
    env[px] = Math.sqrt(sq / Math.max(1, i1 - i0));
  }
  create.env = env;
  create.envWidth = width;
  return env;
}

/* Waveform with the trimmed region lit, the rest dimmed, yellow handles at
   the edges, a time axis, and — while the preview runs — the playhead, so
   you can see which bit of the song you are hearing. */
function drawWave() {
  const canvas = $('#wave');
  if (!canvas || !create.mono) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width = Math.round(canvas.clientWidth * dpr);
  const H = canvas.height = Math.round(canvas.clientHeight * dpr);
  const ctx = canvas.getContext('2d');
  const dur = create.buffer.duration;
  const [a, b] = trimRange();
  const env = envelopeFor(W);
  const axisH = Math.round(14 * dpr);
  const waveH = H - axisH;
  const xOf = (t) => (t / dur) * W;

  ctx.clearRect(0, 0, W, H);

  // the lit region behind the wave
  ctx.fillStyle = 'rgba(79, 209, 197, 0.10)';
  ctx.fillRect(xOf(a), 0, xOf(b) - xOf(a), waveH);

  // wave
  for (let px = 0; px < W; px++) {
    const h = Math.max(1, env[px] * waveH * 1.6);
    const t = (px / W) * dur;
    ctx.fillStyle = t >= a && t <= b ? '#4fd1c5' : '#2a3347';
    ctx.fillRect(px, (waveH - h) / 2, 1, h);
  }

  // time axis: a tick every 5 / 10 / 30 / 60 s depending on length
  const step = dur > 600 ? 60 : dur > 240 ? 30 : dur > 90 ? 10 : 5;
  ctx.fillStyle = '#8d99b5';
  ctx.font = `${Math.round(10 * dpr)}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'bottom';
  for (let t = 0; t < dur; t += step) {
    const x = Math.round(xOf(t));
    ctx.fillRect(x, waveH, 1, Math.round(4 * dpr));
    ctx.fillText(fmtTime(t), x + 3 * dpr, H - 1);
  }

  // trim handles
  ctx.fillStyle = '#ffd166';
  ctx.fillRect(Math.round(xOf(a)), 0, Math.round(2 * dpr), waveH);
  ctx.fillRect(Math.round(xOf(b)) - Math.round(2 * dpr), 0, Math.round(2 * dpr), waveH);

  // playhead — always drawn where the preview is parked, brighter while running
  if (create.preview) {
    const t = create.preview.currentTime;
    const x = Math.round(xOf(t));
    ctx.fillStyle = create.preview.paused ? 'rgba(255,255,255,0.45)' : '#fff';
    ctx.fillRect(x - Math.round(dpr / 2), 0, Math.max(1, Math.round(1.5 * dpr)), waveH);
    if (!create.preview.paused) {
      ctx.beginPath();
      ctx.moveTo(x - 5 * dpr, 0); ctx.lineTo(x + 5 * dpr, 0); ctx.lineTo(x, 6 * dpr);
      ctx.fill();
    }
    const now = $('#trimNow');
    if (now) now.textContent = `${create.preview.paused ? '‖' : '▶'} ${fmtTime(t)}`;
  }
}

function playheadLoop() {
  cancelAnimationFrame(create.raf);
  const tick = () => {
    if (!create.preview || create.preview.paused) { create.raf = 0; return; }
    drawWave();
    create.raf = requestAnimationFrame(tick);
  };
  create.raf = requestAnimationFrame(tick);
}

function paintPlayButtons() {
  const playing = create.preview && !create.preview.paused;
  $('#btnTrimPlay')?.classList.toggle('on', !!playing);
}

/* Seek the preview to `t` and (re)start it. Called from a tap on the wave. */
function previewFrom(t) {
  if (!create.preview) return;
  const [a, b] = trimRange();
  create.preview.currentTime = Math.max(0, Math.min(create.buffer.duration - 0.05, t));
  if (t < a || t > b) {
    // listening outside the trim is allowed — that is how you find where it should be
  }
  create.preview.play().catch(() => {});
}

function wireCreatePanel() {
  const s = $('#trimStart');
  const e = $('#trimEnd');
  s?.addEventListener('input', () => {
    if (Number(s.value) > Number(e.value) - 4) s.value = Math.max(0, Number(e.value) - 4);
    updateTrim();
  });
  e?.addEventListener('input', () => {
    if (Number(e.value) < Number(s.value) + 4) e.value = Math.min(Number(e.max), Number(s.value) + 4);
    updateTrim();
  });

  /* The waveform is a control, not a picture. Near a yellow edge: drag the
     edge. Anywhere else: listen from there. */
  const canvas = $('#wave');
  const timeAt = (ev) => {
    const r = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * create.buffer.duration;
  };
  const GRAB_PX = 12;
  canvas?.addEventListener('pointerdown', (ev) => {
    if (!create.buffer) return;
    const r = canvas.getBoundingClientRect();
    const [a, b] = trimRange();
    const px = ev.clientX - r.left;
    const ax = (a / create.buffer.duration) * r.width;
    const bx = (b / create.buffer.duration) * r.width;
    if (Math.abs(px - ax) <= GRAB_PX) create.drag = 'start';
    else if (Math.abs(px - bx) <= GRAB_PX) create.drag = 'end';
    else { create.drag = null; previewFrom(timeAt(ev)); return; }
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  canvas?.addEventListener('pointermove', (ev) => {
    if (!create.drag) return;
    const t = timeAt(ev);
    if (create.drag === 'start') s.value = Math.min(t, Number(e.value) - 4).toFixed(1);
    else e.value = Math.max(t, Number(s.value) + 4).toFixed(1);
    updateTrim();
  });
  const endDrag = () => { create.drag = null; };
  canvas?.addEventListener('pointerup', endDrag);
  canvas?.addEventListener('pointercancel', endDrag);

  $('#btnTrimPlay')?.addEventListener('click', () => {
    if (!create.preview) return;
    if (!create.preview.paused) { create.preview.pause(); return; }
    const [a, b] = trimRange();
    const t = create.preview.currentTime;
    // resume where it parked if that is inside the trim, else from the start of it
    if (t < a || t >= b) create.preview.currentTime = a;
    create.preview.play().catch(() => {});
  });
  $('#btnTrimStop')?.addEventListener('click', () => {
    if (!create.preview) return;
    create.preview.pause();
    create.preview.currentTime = trimRange()[0];
    drawWave();
  });

  /* Mark the trim at the moment you hear it — the reliable way to find the
     drop, since nobody can read a drop off a waveform. */
  $('#btnMarkStart')?.addEventListener('click', () => {
    if (!create.preview) return;
    const t = create.preview.currentTime;
    s.value = Math.min(t, Number(e.value) - 4).toFixed(1);
    updateTrim();
  });
  $('#btnMarkEnd')?.addEventListener('click', () => {
    if (!create.preview) return;
    const t = create.preview.currentTime;
    e.value = Math.max(t, Number(s.value) + 4).toFixed(1);
    updateTrim();
  });

  $('#btnCreateCancel')?.addEventListener('click', closeCreate);
  $('#btnCreate')?.addEventListener('click', runCreate);
  $('#createName')?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') runCreate(); });

  window.addEventListener('resize', () => { if (create.mono) { create.env = null; drawWave(); } });
}

async function runCreate() {
  if (create.busy || !create.mono) return;
  const label = $('#createName').value.trim();
  if (!label) { $('#createResult').textContent = 'give it a name first'; $('#createName').focus(); return; }

  // an id nobody else has — the server would silently replace a twin
  const taken = new Set((app.actions || []).map((a) => a.id));
  let id = choreo.slug(label);
  for (let n = 2; taken.has(id); n++) id = `${choreo.slug(label)}_${n}`;

  const [a, b] = trimRange();
  const out = $('#createResult');
  create.busy = true;
  create.preview?.pause();
  $('#btnCreate').disabled = true;
  out.textContent = `analysing ${(b - a).toFixed(1)} s…`;

  try {
    /* Let the line above paint before the main thread goes away for a second. */
    await new Promise((r) => setTimeout(r, 30));
    const features = choreo.analyse(create.mono, create.buffer.sampleRate, { start: a, end: b });
    out.textContent = `${features.bpm} BPM · ${features.bars.length} bars · writing steps…`;

    const file = `audio/${id}.mp3`;
    const dance = choreo.choreograph(features, { id, label, audioFile: file, audioStart: a, sourceName: create.file.name });

    out.textContent = `uploading ${create.file.name}…`;
    const up = await fetch(`/api/dances/${id}/audio`, {
      method: 'POST',
      headers: { 'Content-Type': create.file.type || 'audio/mpeg', 'X-Filename': create.file.name },
      body: create.file,
    }).then((r) => r.json());
    if (!up.ok) throw new Error(up.error);
    dance.audio.file = up.file;           // the server decides the extension
    app.audioStamp = Date.now();          // so a re-import of the same name is re-fetched

    const res = await api('/dances', 'POST', dance);
    if (!res.ok) throw new Error(res.error);

    const real = dance.steps.filter((s) => typeof s === 'object').length;
    danceSay(`created "${label}" — ${features.bpm} BPM, ${features.bars.length} bars, ${real} steps, ${dance.audio.start}–${dance.audio.end} s`);
    closeCreate();
  } catch (err) {
    out.textContent = `create failed: ${err.message}`;
    create.busy = false;
    $('#btnCreate').disabled = false;
  }
}

/* The voice-agent switch on the Head tab. */
function renderAgent() {
  const btn = $('#btnAgent');
  if (!btn) return;
  btn.classList.toggle('on', !!app.voiceAgent);
  btn.textContent = app.voiceAgent ? '🗣 Voice agent: on' : '🗣 Voice agent: off';
}

/* The Live button. The phone does the work; this only shows what is true. */
function renderLive() {
  const btn = $('#btnLive');
  if (!btn) return;
  btn.classList.toggle('on', !!app.live);
  btn.textContent = app.live ? '🎤 Live — stop' : '🎤 Live';
  $('#dancePage')?.classList.toggle('is-live', !!app.live);
}

const fullscreenEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;

/**
 * Best effort, and it has to be called straight out of the click handler:
 * requestFullscreen needs transient user activation, and anything that puts a
 * timer or an await in front of it gets refused with nothing worth reading.
 */
function toggleFullscreen(target) {
  try {
    if (fullscreenEl()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      exit?.call(document);
      return;
    }
    const req = target.requestFullscreen || target.webkitRequestFullscreen;
    req?.call(target, { navigationUI: 'hide' });
  } catch { /* refused — carry on windowed */ }
}

// ------------------------------------------------------------------- voice

/**
 * Push-to-talk. The recorder captures Opus in the browser, the server hands the
 * blob to a local Whisper process, and the transcript goes to a local Ollama
 * model which picks one of the actions above. Both hops are on this machine, so
 * the microphone feed never leaves it.
 */
const voice = { rec: null, chunks: [], stream: null, busy: false };

function voiceShow(stage, heard, match, via) {
  const bar = $('#voiceBar');
  if (!bar) return;
  bar.hidden = false;
  bar.dataset.stage = stage;
  $('#voiceStage').textContent = stage;
  if (heard !== undefined) $('#voiceHeard').textContent = heard || '—';
  $('#voiceMatch').textContent = match || '';
  $('#voiceVia').textContent = via || '';
}

function micLabel(text, listening) {
  const btn = $('#btnMic');
  $('#micLabel').textContent = text;
  btn.classList.toggle('listening', !!listening);
  btn.disabled = voice.busy && !listening;
}

async function voiceStart() {
  if (voice.rec || voice.busy) return;
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    voiceShow('error', '', 'microphone blocked — allow it for this page', '');
    return;
  }

  voice.chunks = [];
  voice.rec = new MediaRecorder(voice.stream);
  voice.rec.ondataavailable = (e) => { if (e.data.size) voice.chunks.push(e.data); };
  voice.rec.onstop = () => voiceFinish();
  voice.rec.start();

  micLabel('Listening…', true);
  voiceShow('listening', '', 'speak your command', '');
}

function voiceStop() {
  if (!voice.rec || voice.rec.state === 'inactive') return;
  voice.rec.stop();
  voice.stream?.getTracks().forEach((t) => t.stop());
}

async function voiceFinish() {
  const blob = new Blob(voice.chunks, { type: voice.rec?.mimeType || 'audio/webm' });
  voice.rec = null;
  voice.stream = null;
  voice.busy = true;
  micLabel('Thinking…', false);
  voiceShow('transcribing', '', 'running speech-to-text locally…', '');

  try {
    const res = await fetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'transcription failed');

    if (!data.text) {
      voiceShow('nothing heard', '', 'no speech detected — try again, closer to the mic', '');
      return;
    }
    voiceShow('matching', data.text, 'choosing an action…', '');
    await voiceSend(data.text);
  } catch (err) {
    voiceShow('error', '', err.message, '');
  } finally {
    voice.busy = false;
    micLabel('Speak', false);
  }
}

/** Send a phrase (spoken or typed) for intent matching, and run what it maps to. */
async function voiceSend(text) {
  voiceShow('matching', text, 'choosing an action…', '');
  const data = await api('/voice/command', 'POST', { text });

  if (!data.ok) {
    voiceShow('error', text, data.error || 'command failed', '');
    return;
  }
  if (!data.action) {
    voiceShow('no match', data.text, 'nothing matched — the robot stayed put', data.via || '');
    return;
  }
  const pct = data.confidence != null ? ` · ${Math.round(data.confidence * 100)}%` : '';
  voiceShow('running', data.text, `▶ ${data.label || data.action}`, `${data.via}${pct}`);
}

async function renderVoiceHealth() {
  const host = $('#voiceHealth');
  if (!host) return;
  let h;
  try {
    h = await api('/voice/health');
  } catch {
    host.innerHTML = '';
    host.append(svcRow(false, 'could not reach the control server'));
    return;
  }

  host.innerHTML = '';
  host.append(svcRow(h.stt?.ok, `Speech-to-text (:8123) — ${h.stt?.ok ? 'ready' : h.stt?.detail || 'down'}`));
  host.append(svcRow(h.ollama?.ok, `Ollama ${h.model} (:11434) — ${h.ollama?.ok ? 'ready' : h.ollama?.detail || 'down'}`));

  const hint = $('#voiceHealthHint');
  if (hint && !h.stt?.ok) {
    hint.innerHTML = 'Speech-to-text is not running — start it with <code>npm run stt</code> in the backend folder. '
      + 'The typed box above still works without it.';
  }
}

function svcRow(ok, text) {
  const row = el('div', `svc ${ok ? 'ok' : 'bad'}`);
  row.append(el('span', 'svc-dot'), el('span', null, text));
  return row;
}

function wireVoice() {
  const btn = $('#btnMic');
  if (!btn) return;

  /* Click to start, click to stop — and hold-to-talk falls out of the same
     handlers for anyone who expects a walkie-talkie. A press shorter than the
     threshold is treated as a click and leaves recording running. */
  let pressedAt = 0;
  const HOLD_MS = 400;

  btn.addEventListener('pointerdown', () => { pressedAt = Date.now(); if (!voice.rec) voiceStart(); });
  btn.addEventListener('pointerup', () => {
    if (Date.now() - pressedAt > HOLD_MS) voiceStop();   // was a hold
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (voice.rec && Date.now() - pressedAt <= HOLD_MS) voiceStop();  // second click of click-to-toggle
  });

  $('#btnVoiceClose')?.addEventListener('click', () => { $('#voiceBar').hidden = true; });
  $('#btnActionStop')?.addEventListener('click', () => send({ type: 'action', command: 'stop' }));

  const input = $('#voiceText');
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    voiceSend(text).catch((err) => voiceShow('error', text, err.message, ''));
  };
  $('#btnVoiceText')?.addEventListener('click', submit);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  renderVoiceHealth();
  setInterval(renderVoiceHealth, 15000);
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
  $('#btnHeadCenter').onclick = () => setJoint('head_tilt', 50, true);

  $('#btnDownloadSetup').onclick = () => {
    const blob = new Blob([JSON.stringify(app.setup, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'setup.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const headTilt = $('#headTilt');
  if (headTilt) {
    headTilt.addEventListener('input', () => {
      const travel = Number(headTilt.value);
      $('#headTiltOut').textContent = `${travel} %`;
      setJoint('head_tilt', travel, true);
    });
  }
  for (const btn of document.querySelectorAll('[data-head-tilt]')) {
    btn.addEventListener('click', () => setJoint('head_tilt', Number(btn.dataset.headTilt), true));
  }

  wireDrive();
  wireMotor();
  wireLight();
  wireVoice();
  wireDance();
  wireEyes();
  wireSequence();
  wireRecord();
  setInterval(renderDevices, 2000);
}

connect();
