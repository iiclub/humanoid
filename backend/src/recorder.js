'use strict';

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.resolve(__dirname, '..', '..', 'config', 'recordings.json');

/**
 * Live record / play.
 *
 * RECORD  captures every command the controller emits (joint moves, drive) as
 *         timestamped frames — so anything you do by hand, from any client, is
 *         caught: sliders, pads, preset poses, the D-pad, the thumb-stick.
 *
 * PLAY    replays those frames with their original timing, straight back through
 *         the controller, optionally in an endless loop.
 *
 * Frames look like:  { t: msFromStart, kind: 'joint'|'drive'|'motor'|'light', ... }
 *
 * Playback re-drives the base at ~4 Hz while a non-zero drive frame is active,
 * because the drive firmware has a 600 ms "no command -> stop" failsafe; a
 * single recorded "forward" frame would otherwise stall after 0.6 s.
 */
class Recorder {
  constructor({ controller, onStatus }) {
    this.controller = controller;
    this.onStatus = onStatus || (() => {});

    this.recording = false;
    this.playing = false;

    this.frames = [];          // the current (unsaved) take
    this.name = null;          // name of the loaded take, if any
    this.recStart = 0;

    this.timers = [];
    this.driveKeepAlive = null;
    this.lastDrive = { left: 0, right: 0 };
    this.lastMotor = { dir: 0 };
    this.loop = false;
    this.playToken = 0;        // invalidates in-flight timers when we stop
    this.loopCount = 0;

    this.saved = this._loadStore();
  }

  // ------------------------------------------------------------- capture hook

  /** Wired to controller.onAction. Ignores its own playback so takes can't nest. */
  capture(evt) {
    if (!this.recording || this.playing) return;
    this.frames.push({ t: Date.now() - this.recStart, ...evt });
    // Throttle status spam: only ping the UI on a fresh frame count milestone.
    if (this.frames.length % 5 === 0) this._emit();
  }

  // -------------------------------------------------------------------- record

  startRecording() {
    this.stopPlayback();
    this.frames = [];
    this.name = null;
    this.recStart = Date.now();
    this.recording = true;
    this._emit();
    return this.status();
  }

  stopRecording() {
    if (!this.recording) return this.status();
    this.recording = false;
    // normalise so the first frame is at t=0
    if (this.frames.length) {
      const t0 = this.frames[0].t;
      for (const f of this.frames) f.t -= t0;
    }
    this._emit();
    return this.status();
  }

  clear() {
    this.stopPlayback();
    this.recording = false;
    this.frames = [];
    this.name = null;
    this._emit();
    return this.status();
  }

  // -------------------------------------------------------------------- play

  play({ loop = false } = {}) {
    if (!this.frames.length) throw new Error('nothing recorded to play');
    this.stopPlayback();
    this.recording = false;
    this.loop = !!loop;
    this.playing = true;
    this.loopCount = 0;
    const token = ++this.playToken;
    this._emit();
    this._scheduleTake(token);
    return this.status();
  }

  _scheduleTake(token) {
    const frames = this.frames;
    const duration = frames.length ? frames[frames.length - 1].t : 0;

    for (const f of frames) {
      this.timers.push(setTimeout(() => {
        if (token !== this.playToken) return;
        this._apply(f);
      }, f.t));
    }

    // End of take: stop the base, then either loop or finish.
    this.timers.push(setTimeout(() => {
      if (token !== this.playToken) return;
      this._stopKeepAlive();
      this.controller.driveRaw(0, 0, 'stop');
      this.lastDrive = { left: 0, right: 0 };
      this._stopMotor();

      if (this.loop) {
        this.loopCount++;
        this._emit();
        // small gap between loops so a viewer can see the reset
        this.timers.push(setTimeout(() => {
          if (token !== this.playToken) return;
          this._scheduleTake(token);
        }, 400));
      } else {
        this.playing = false;
        this._emit();
      }
    }, duration + 60));
  }

  _apply(frame) {
    try {
      if (frame.kind === 'joint') {
        this.controller.setJoint(frame.id, frame.travel);
      } else if (frame.kind === 'drive') {
        this.controller.driveRaw(frame.left, frame.right, 'replay');
        this.lastDrive = { left: frame.left, right: frame.right };
        this._armKeepAlive();
      } else if (frame.kind === 'motor') {
        this.controller.setMotor(frame.dir);
        this.lastMotor = { dir: frame.dir };
        this._armKeepAlive();
      } else if (frame.kind === 'light') {
        // Nothing to keep alive: the light latches, it has no failsafe.
        if (frame.sequence) this.controller.lightSequence();
        else this.controller.setLight(frame.on);
      }
    } catch {
      /* a node may be offline mid-playback; keep going */
    }
  }

  /**
   * Re-send whatever is currently running so the firmware failsafes don't stop
   * it: the base (600 ms) and the aux motor (600 ms) both expect a fresh packet.
   */
  _armKeepAlive() {
    if (this.driveKeepAlive) return;
    this.driveKeepAlive = setInterval(() => {
      if (!this.playing) return this._stopKeepAlive();
      const { left, right } = this.lastDrive;
      if (left !== 0 || right !== 0) this.controller.driveRaw(left, right, 'replay');
      if (this.lastMotor.dir !== 0) this.controller.setMotor(this.lastMotor.dir);
    }, 250);
  }

  _stopKeepAlive() {
    if (this.driveKeepAlive) clearInterval(this.driveKeepAlive);
    this.driveKeepAlive = null;
  }

  _stopMotor() {
    this.lastMotor = { dir: 0 };
    try { this.controller.setMotor(0); } catch { /* no motor section in setup.json */ }
  }

  stopPlayback() {
    this.playToken++;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this._stopKeepAlive();
    if (this.playing) {
      this.controller.driveRaw(0, 0, 'stop');
      this.lastDrive = { left: 0, right: 0 };
      this._stopMotor();
    }
    this.playing = false;
    this.loop = false;
    this._emit();
    return this.status();
  }

  // ------------------------------------------------------------ named library

  save(name) {
    if (!name) throw new Error('a name is required');
    if (!this.frames.length) throw new Error('nothing recorded to save');
    const clean = name.trim().replace(/[^\w -]/g, '').slice(0, 40) || 'take';
    this.saved[clean] = {
      name: clean,
      frames: this.frames,
      duration: this.frames[this.frames.length - 1].t,
      savedAt: Date.now(),
    };
    this.name = clean;
    this._persist();
    this._emit();
    return this.status();
  }

  load(name) {
    const take = this.saved[name];
    if (!take) throw new Error(`no recording named "${name}"`);
    this.stopPlayback();
    this.frames = take.frames.map((f) => ({ ...f }));
    this.name = name;
    this._emit();
    return this.status();
  }

  remove(name) {
    if (this.saved[name]) {
      delete this.saved[name];
      if (this.name === name) this.name = null;
      this._persist();
    }
    this._emit();
    return this.status();
  }

  // ------------------------------------------------------------------ status

  status() {
    const duration = this.frames.length ? this.frames[this.frames.length - 1].t : 0;
    return {
      recording: this.recording,
      playing: this.playing,
      loop: this.loop,
      loopCount: this.loopCount,
      frames: this.frames.length,
      duration,
      name: this.name,
      saved: Object.values(this.saved)
        .map((t) => ({ name: t.name, frames: t.frames.length, duration: t.duration, savedAt: t.savedAt }))
        .sort((a, b) => b.savedAt - a.savedAt),
    };
  }

  _emit() { this.onStatus(this.status()); }

  _loadStore() {
    try {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch {
      return {};
    }
  }

  _persist() {
    try {
      fs.writeFileSync(STORE_PATH, JSON.stringify(this.saved, null, 2) + '\n', 'utf8');
    } catch (err) {
      // non-fatal: recording still works in memory
      console.error('could not persist recordings:', err.message);
    }
  }
}

module.exports = { Recorder, STORE_PATH };
