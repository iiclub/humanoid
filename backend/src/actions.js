'use strict';

const fs = require('fs');
const path = require('path');

const ACTIONS_PATH = path.resolve(__dirname, '..', '..', 'config', 'actions.json');
const DANCES_PATH = path.resolve(__dirname, '..', '..', 'config', 'dances.json');

/**
 * The named-gesture library: "handshake", "wave", "hands up" — and the
 * choreography: "Rehman Dakait — Entry".
 *
 * An action is a list of timed steps, each a partial pose. The steps are held,
 * not interpolated — the firmware already slews every servo at its own
 * SERVO_SPEED, so re-interpolating here would fight it and produce a stutter.
 * A step's `ms` is therefore dwell time: how long to let the joints travel and
 * settle before commanding the next one.
 *
 * Dances live in their own file but are otherwise the same thing, merged into
 * one catalogue and tagged `kind: 'dance'`. One registry means one player, and
 * one player means starting a dance cancels whatever gesture was mid-flight
 * instead of two timer chains fighting over the same shoulder. It also gets the
 * routines into the voice matcher for free.
 *
 * This is deliberately the same shape as the recorder's playback: one timer
 * chain, cancellable at any point, and hard-stopped by E-STOP.
 */

function load(force = false) {
  if (!force && load._cache) return load._cache;

  const actions = readFile(ACTIONS_PATH, 'actions', 'action');
  const dances = fs.existsSync(DANCES_PATH)
    ? readFile(DANCES_PATH, 'dances', 'dance')
    : { list: [], raw: {} };

  const merged = {
    version: 1,
    actions: [...actions.list, ...dances.list],
    /* Default music for a routine that names no file of its own, relative to
       frontend/. The generated beat — tools/make-beat.js — so this one does
       exist in a fresh checkout. */
    audioFile: (dances.raw._audio && dances.raw._audio.file) || null,
  };
  validate(merged);
  load._cache = merged;
  return merged;
}

const AUDIO_DIR = path.resolve(__dirname, '..', '..', 'frontend', 'audio');

/* Dance ids double as audio filenames and end up in URLs, so they are held to
   the same alphabet the hand-written ones use — no path separators, no case
   games on a case-insensitive disk. */
const ID_RE = /^[a-z0-9_]{1,40}$/;
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'webm', 'flac'];

function readFile(file, key, kind) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed[key])) {
    throw new Error(`${path.basename(file)}: "${key}" must be an array`);
  }
  return { list: parsed[key].map((a) => ({ ...a, kind })), raw: parsed };
}

function validate(cfg) {
  if (!cfg || !Array.isArray(cfg.actions)) throw new Error('actions.json: "actions" must be an array');
  const seen = new Set();
  for (const a of cfg.actions) {
    if (!a.id) throw new Error(`${a.kind || 'action'}: an entry has no "id"`);
    if (seen.has(a.id)) throw new Error(`duplicate action id "${a.id}" — ids are shared across actions.json and dances.json`);
    seen.add(a.id);
    if (!Array.isArray(a.steps) || !a.steps.length) {
      throw new Error(`action "${a.id}" needs a non-empty "steps" array`);
    }
    if (!a.steps.some((s) => s && typeof s === 'object')) {
      throw new Error(`action "${a.id}" has only section markers, no real steps`);
    }
  }
}

/**
 * Tighter checks for a dance arriving over the wire — from the choreographer
 * or an imported .json — before it is written into dances.json. The file
 * validator above is lenient because a hand-edited file is trusted; this is
 * not. Returns the cleaned object; nothing outside the known fields survives.
 */
function sanitiseDance(input) {
  if (!input || typeof input !== 'object') throw new Error('a dance must be an object');
  const id = String(input.id || '').trim();
  if (!ID_RE.test(id)) throw new Error(`bad id "${id}" — lowercase letters, digits, underscores, max 40`);
  const label = String(input.label || '').trim().slice(0, 60);
  if (!label) throw new Error('a dance needs a label');
  if (!Array.isArray(input.steps) || !input.steps.length) throw new Error('a dance needs a non-empty steps array');

  const num = (v, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(lo, Math.min(hi, n));
  };

  let count = 0;
  const cleanSteps = (steps, depth = 0) => {
    if (depth > 4) throw new Error('repeat blocks nested too deeply');
    const out = [];
    for (const s of steps) {
      if (typeof s === 'string') { out.push(s.slice(0, 200)); continue; }
      if (!s || typeof s !== 'object') continue;
      if (s.repeat) {
        out.push({ repeat: Math.max(1, Math.min(50, Math.round(Number(s.repeat) || 1))), steps: cleanSteps(s.steps || [], depth + 1) });
        continue;
      }
      if (++count > 2000) throw new Error('too many steps (max 2000)');
      const step = { ms: Math.max(50, Math.min(15000, Math.round(Number(s.ms) || 600))) };
      if (s.pose && typeof s.pose === 'object') {
        step.pose = {};
        for (const [k, v] of Object.entries(s.pose)) {
          /* Arms are three motors each — shoulder_x, shoulder_y, elbow. A
             dance never drives the wrists or the grippers, so those keys are
             dropped here rather than trusted to whoever wrote the file. */
          if (/_(wrist_z|gripper)$/.test(k)) continue;
          if (/^[a-z_]{1,32}$/.test(k)) { const t = num(v, 0, 100); if (t != null) step.pose[k] = Math.round(t); }
        }
      }
      if (s.light != null) step.light = !!s.light;
      if (s.motor === 'up' || s.motor === 'down' || s.motor === 'stop') step.motor = s.motor;
      if (s.eyes && typeof s.eyes === 'object') {
        const e = {};
        if (s.eyes.look != null) e.look = num(s.eyes.look, -100, 100);
        if (s.eyes.swing != null) e.swing = !!s.eyes.swing;
        if (s.eyes.lids === 'open' || s.eyes.lids === 'closed') e.lids = s.eyes.lids;
        if (s.eyes.speed != null) e.speed = num(s.eyes.speed, 1, 100);
        if (s.eyes.blink != null) e.blink = !!s.eyes.blink;
        if (s.eyes.auto != null) e.auto = !!s.eyes.auto;
        if (s.eyes.fx === 'dj' || s.eyes.fx === 'none') e.fx = s.eyes.fx;
        if (s.eyes.bpm != null) e.bpm = num(s.eyes.bpm, 40, 200);
        step.eyes = e;
      }
      /* Deliberately no `drive`. A routine that arrives over the network does
         not get to roll the robot across the floor; hand-edit the file if you
         want that and know why. */
      out.push(step);
    }
    return out;
  };

  const dance = { id, label };
  if (input.bpm != null) dance.bpm = Math.round(num(input.bpm, 40, 200) || 100);
  if (input.audio && typeof input.audio === 'object') {
    const a = {};
    if (input.audio.file != null) {
      const f = String(input.audio.file);
      if (!/^audio\/[a-z0-9_-]+\.[a-z0-9]{1,5}$/i.test(f)) throw new Error(`bad audio.file "${f}"`);
      a.file = f;
    }
    a.start = num(input.audio.start, 0, 36000) ?? 0;
    a.end = num(input.audio.end, 0, 36000) ?? 0;
    dance.audio = a;
  }
  dance.description = String(input.description || `The "${label}" routine.`).slice(0, 400);
  dance.utterances = (Array.isArray(input.utterances) ? input.utterances : [label])
    .map((u) => String(u).slice(0, 60)).slice(0, 20);
  dance.steps = cleanSteps(input.steps);
  if (!dance.steps.some((s) => s && typeof s === 'object')) throw new Error('no real steps');
  return dance;
}

/* Read-modify-write on dances.json. The prose keys (_about, _fields …) and the
   string comments inside steps are ordinary JSON to the parser, so they
   survive the round trip; only the whitespace is renormalised. */
function readDancesRaw() {
  return fs.existsSync(DANCES_PATH)
    ? JSON.parse(fs.readFileSync(DANCES_PATH, 'utf8'))
    : { version: 2, dances: [] };
}

function writeDancesRaw(raw) {
  const tmp = `${DANCES_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  fs.renameSync(tmp, DANCES_PATH);
}

/** Path for a dance's own audio, given the client's filename (for the extension). */
function audioPathFor(id, filename) {
  if (!ID_RE.test(id)) throw new Error(`bad id "${id}"`);
  const got = (/\.([a-z0-9]{1,5})$/i.exec(String(filename || '')) || [, ''])[1].toLowerCase();
  const ext = AUDIO_EXT.includes(got) ? got : 'mp3';
  return { rel: `audio/${id}.${ext}`, abs: path.join(AUDIO_DIR, `${id}.${ext}`) };
}

/** Delete audio/<id>.* — everything a removed dance left behind. */
function removeAudioFor(id) {
  if (!ID_RE.test(id)) return;
  try {
    for (const f of fs.readdirSync(AUDIO_DIR)) {
      if (f.startsWith(`${id}.`) && AUDIO_EXT.includes(f.slice(id.length + 1).toLowerCase())) {
        fs.unlinkSync(path.join(AUDIO_DIR, f));
      }
    }
  } catch { /* no audio dir */ }
}

/** Expands nested `repeat` blocks into one flat list of steps. */
function flatten(steps, depth = 0) {
  if (depth > 4) throw new Error('actions.json: repeat blocks nested too deeply');
  const out = [];
  for (const step of steps) {
    /* JSON cannot carry comments and unreadable choreography is unmaintainable
       choreography, so a bare string in a steps array is a section marker. */
    if (typeof step === 'string' || !step) continue;
    if (step.repeat) {
      const times = Math.max(1, Math.min(50, Number(step.repeat) || 1));
      const inner = flatten(step.steps || [], depth + 1);
      for (let i = 0; i < times; i++) out.push(...inner);
    } else {
      out.push(step);
    }
  }
  return out;
}

class ActionPlayer {
  constructor({ controller, state, onStatus, log }) {
    this.controller = controller;
    this.state = state;
    this.onStatus = onStatus || (() => {});
    this.log = log || (() => {});

    this.timer = null;
    this.current = null;   // { id, label, step, total, startedAt }
  }

  get catalogue() {
    return load().actions.map(({ id, label, description, utterances, kind, bpm, audio }) => ({
      id, label, description, utterances: utterances || [],
      kind: kind || 'action',
      bpm: bpm || null,
      audio: audio || null,
    }));
  }

  /** Default music, relative to frontend/, for a dance that names no file. */
  get audioFile() {
    return load().audioFile;
  }

  /**
   * Cache-buster for every audio URL: the newest mtime in frontend/audio/.
   *
   * The browser is told these files may be cached, and a dance's audio keeps
   * the same name when it is replaced — so without something in the URL that
   * changes, a page can go on playing the copy it fetched days ago. That is
   * not hypothetical: replacing two tracks with louder masters left every open
   * client, and every fresh page load, still serving the quiet ones.
   *
   * Deriving it from mtime rather than bumping a counter on upload means it is
   * also right for files changed on disk by hand, and survives a restart.
   */
  get audioStamp() {
    try {
      let newest = 0;
      for (const f of fs.readdirSync(AUDIO_DIR)) {
        const t = fs.statSync(path.join(AUDIO_DIR, f)).mtimeMs;
        if (t > newest) newest = t;
      }
      return Math.round(newest);
    } catch {
      return 0;
    }
  }

  /**
   * Append (or replace, same id) a dance in dances.json and reload.
   * The catalogue the caller sees afterwards is the one every client will get
   * on the next broadcast — the write and the reload are one operation.
   */
  addDance(input) {
    const dance = sanitiseDance(input);
    if (this.current && this.current.id === dance.id) this.stop({ silent: true });

    const raw = readDancesRaw();
    if (!Array.isArray(raw.dances)) raw.dances = [];
    const at = raw.dances.findIndex((d) => d && d.id === dance.id);
    if (at >= 0) raw.dances[at] = dance; else raw.dances.push(dance);

    /* Check the merged result BEFORE writing: a dance whose id collides with a
       gesture in actions.json is rejected here rather than bricking the file. */
    const trial = { actions: [...load().actions.filter((a) => a.kind !== 'dance'), ...raw.dances.map((d) => ({ ...d, kind: 'dance' }))] };
    validate(trial);

    writeDancesRaw(raw);
    this.reload();
    this.log('http', `dance "${dance.id}" ${at >= 0 ? 'replaced' : 'added'} — ${dance.label}`);
    return dance;
  }

  removeDance(id) {
    if (!ID_RE.test(String(id))) throw new Error(`bad id "${id}"`);
    const raw = readDancesRaw();
    const before = (raw.dances || []).length;
    raw.dances = (raw.dances || []).filter((d) => !d || d.id !== id);
    if (raw.dances.length === before) throw new Error(`no dance "${id}"`);
    if (this.current && this.current.id === id) this.stop({ silent: true });

    writeDancesRaw(raw);
    removeAudioFor(id);
    this.reload();
    this.log('http', `dance "${id}" removed`);
    return this.catalogue;
  }

  find(id) {
    return load().actions.find((a) => a.id === id) || null;
  }

  /**
   * Re-read both JSON files. This is what makes choreography iterable: edit
   * dances.json, reload, play it again — a server restart would drop every
   * NodeMCU's registration and mean walking back to the robot.
   *
   * A broken file leaves the old catalogue in place rather than emptying it.
   */
  reload() {
    const before = load._cache;
    try {
      load._cache = null;
      return load();
    } catch (err) {
      load._cache = before;
      throw err;
    }
  }

  status() {
    return {
      playing: !!this.current,
      action: this.current ? { id: this.current.id, label: this.current.label, kind: this.current.kind } : null,
      step: this.current ? this.current.step : 0,
      steps: this.current ? this.current.total : 0,
    };
  }

  /**
   * Starts an action, replacing whatever was running. Returns immediately —
   * the steps play out on timers so the HTTP request or WebSocket frame that
   * triggered it is not held open for the length of the gesture.
   */
  run(id) {
    const action = this.find(id);
    if (!action) throw new Error(`unknown action "${id}"`);
    if (this.state.estop) throw new Error('E-STOP is armed — release it first');

    this.stop({ silent: true });

    const steps = flatten(action.steps);
    this._usedDrive = false;
    this.current = {
      id: action.id,
      label: action.label || action.id,
      kind: action.kind || 'action',
      step: 0,
      total: steps.length,
      startedAt: Date.now(),
    };
    this.log('http', `action "${action.id}" — ${steps.length} steps`);
    this.onStatus(this.status());

    const next = (i) => {
      if (!this.current || this.current.id !== action.id) return;   // superseded or stopped
      if (this.state.estop) { this.stop(); return; }

      if (i >= steps.length) {
        this._finish();
        return;
      }

      const step = steps[i];
      this.current.step = i + 1;

      try {
        this._apply(step);
      } catch (err) {
        this.log('warn', `action "${action.id}" step ${i + 1}: ${err.message}`);
      }

      this.onStatus(this.status());
      const ms = Math.max(50, Math.min(15000, Number(step.ms) || 600));
      this.timer = setTimeout(() => next(i + 1), ms);

      /* The torso and the wheels are both hold-to-run: the firmware parks them
         if commands stop arriving, so a step that drives one has to keep feeding
         the link for as long as the step lasts. Servos latch and need no
         keep-alive. The wheels have the shorter fuse of the two — failsafeMs is
         600 against the torso's 4000 — so the same 250 ms cadence covers both. */
      if (step.motor && step.motor !== 'stop') this._holdMotor(step.motor, ms);
      if (this._isMoving(step.drive)) this._holdDrive(step.drive, ms);
    };

    next(0);
    return this.status();
  }

  _apply(step) {
    if (step.pose && Object.keys(step.pose).length) this.controller.setPose(step.pose);
    if (step.light != null) this.controller.setLight(!!step.light);
    if (step.eyes) this.controller.setEyes(step.eyes);
    if (step.motor) this.controller.motorCommand(step.motor);
    if (step.drive) this._drive(step.drive);
  }

  /**
   * `drive` on a step: "stop", { cmd, speed } or { left, right }.
   *
   * A routine that rolls the robot across a floor is a different proposition
   * from one that waves, so the fact that a run ever touched the wheels is
   * latched — _finish and stop then both park the base explicitly rather than
   * relying on the firmware's 600 ms failsafe to notice the timers went quiet.
   */
  _drive(spec) {
    if (spec === 'stop' || spec === false) return this.controller.driveRaw(0, 0, 'stop');
    this._usedDrive = true;
    if (typeof spec === 'object' && (spec.left != null || spec.right != null)) {
      return this.controller.driveRaw(spec.left || 0, spec.right || 0, 'action');
    }
    return this.controller.drive(spec.cmd || 'forward', spec.speed);
  }

  _isMoving(spec) {
    if (!spec || spec === 'stop' || spec === false) return false;
    if (spec.left != null || spec.right != null) return !!(Number(spec.left) || Number(spec.right));
    return spec.cmd !== 'stop';
  }

  /** Re-sends the torso direction every 250 ms, the same cadence the UI uses. */
  _holdMotor(cmd, ms) {
    const started = Date.now();
    const tick = () => {
      if (!this.current || this.state.estop) return;
      if (Date.now() - started >= ms) return;
      try { this.controller.motorCommand(cmd); } catch { /* node may be offline */ }
      this.motorTimer = setTimeout(tick, 250);
    };
    this.motorTimer = setTimeout(tick, 250);
  }

  /** Same idea for the wheels, which stop by themselves after failsafeMs. */
  _holdDrive(spec, ms) {
    const started = Date.now();
    const tick = () => {
      if (!this.current || this.state.estop) return;
      if (Date.now() - started >= ms) return;
      try { this._drive(spec); } catch { /* node may be offline */ }
      this.driveTimer = setTimeout(tick, 250);
    };
    this.driveTimer = setTimeout(tick, 250);
  }

  _clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.motorTimer) clearTimeout(this.motorTimer);
    if (this.driveTimer) clearTimeout(this.driveTimer);
    this.timer = null;
    this.motorTimer = null;
    this.driveTimer = null;
  }

  /** Park everything that runs rather than latches. Servos keep their angle. */
  _park() {
    try { this.controller.motorCommand('stop'); } catch { /* node may be offline */ }
    if (this._usedDrive) {
      try { this.controller.driveRaw(0, 0, 'stop'); } catch { /* node may be offline */ }
    }
    this._usedDrive = false;
  }

  _finish() {
    const id = this.current?.id;
    this._clearTimers();
    this.current = null;
    /* Any action that touched the torso or the wheels leaves them parked.
       Servos hold their last angle, which is what "the gesture ended here"
       should look like. */
    this._park();
    if (id) this.log('http', `action "${id}" finished`);
    this.onStatus(this.status());
  }

  stop({ silent = false } = {}) {
    if (!this.current) return this.status();
    const id = this.current.id;
    this._clearTimers();
    this.current = null;
    this._park();
    if (!silent) this.log('warn', `action "${id}" stopped`);
    this.onStatus(this.status());
    return this.status();
  }
}

module.exports = {
  ActionPlayer, load, validate, sanitiseDance, audioPathFor, removeAudioFor,
  ACTIONS_PATH, DANCES_PATH, AUDIO_DIR, ID_RE,
};
