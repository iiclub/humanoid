'use strict';

const joints = require('./joints');

/**
 * Turns high level intents ("put the right elbow at 40 % travel", "drive
 * forward at 70 %") into UDP packets, coalescing everything that lands on the
 * same NodeMCU into a single datagram, and rate limiting per node so a slider
 * drag cannot flood an ESP8266.
 */
class Controller {
  constructor({ setup, state, link, onChange, onAction }) {
    this.setup = setup;
    this.state = state;
    this.link = link;
    this.onChange = onChange || (() => {});
    // Tap for the recorder: fires once per actionable command. Kept separate
    // from onChange (which drives the WebSocket) so playback can't feed itself.
    this.onAction = onAction || (() => {});
    this.jointMap = joints.byId(setup);

    const hz = setup.network.commandRateHz || 25;
    this.minIntervalMs = Math.floor(1000 / hz);
    this.pending = new Map();   // nodeId -> { channel: angle }
    this.lastSent = new Map();  // nodeId -> timestamp
    this.flushTimer = null;
  }

  // ---------------------------------------------------------------- joints --

  setJoint(id, travel, { flush = true } = {}) {
    const joint = this.jointMap.get(id);
    if (!joint) throw new Error(`unknown joint "${id}"`);
    if (this.state.estop) return { id, travel: this.state.pose[id], blocked: 'estop' };

    const applied = this.state.setJoint(id, travel);
    const angle = joints.travelToAngle(joint, applied);
    this._queue(joint.node, joint.channel, angle);
    if (flush) this._schedule();
    this.onChange({ type: 'pose', pose: this.state.pose });
    this.onAction({ kind: 'joint', id, travel: applied });
    return { id, travel: applied, angle, node: joint.node, channel: joint.channel };
  }

  setPose(pose) {
    const results = [];
    for (const [id, travel] of Object.entries(pose || {})) {
      if (!this.jointMap.has(id)) continue;
      results.push(this.setJoint(id, travel, { flush: false }));
    }
    this._schedule();
    return results;
  }

  applyNamedPose(name) {
    const pose = this.setup.poses?.[name];
    if (!pose) throw new Error(`unknown pose "${name}"`);
    return this.setPose(pose);
  }

  goHome() {
    return this.setPose(joints.homePose(this.setup));
  }

  /** Push every joint out again — used after a node reboots and rejoins. */
  resync(nodeId = null) {
    for (const joint of this.setup.joints) {
      if (nodeId && joint.node !== nodeId) continue;
      const angle = joints.travelToAngle(joint, this.state.pose[joint.id] ?? 0);
      this._queue(joint.node, joint.channel, angle);
    }
    this._flush(true);
  }

  // ----------------------------------------------------------------- drive --

  /**
   * cmd: forward | reverse | left | right | stop
   * speed: 0..maxPwm (defaults to setup.drive.defaultSpeed)
   */
  drive(cmd, speed) {
    const cfg = this.setup.drive;
    if (!cfg) throw new Error('no drive section in setup.json');
    const max = cfg.maxPwm || 1023;
    const s = joints.clamp(Number(speed ?? cfg.defaultSpeed) || 0, 0, max);
    const turn = cfg.turnScale ?? 1;

    let left = 0;
    let right = 0;
    switch (cmd) {
      case 'forward': left = s; right = s; break;
      case 'reverse': left = -s; right = -s; break;
      case 'left': left = -s * turn; right = s * turn; break;
      case 'right': left = s * turn; right = -s * turn; break;
      case 'stop': left = 0; right = 0; break;
      default: throw new Error(`unknown drive command "${cmd}"`);
    }
    return this.driveRaw(left, right, cmd);
  }

  /** Direct differential control, e.g. from a joystick: -max..max per side. */
  driveRaw(left, right, cmd = 'manual') {
    const cfg = this.setup.drive;
    const max = cfg.maxPwm || 1023;
    if (this.state.estop) { left = 0; right = 0; cmd = 'estop'; }

    const l = Math.round(joints.clamp(Number(left) || 0, -max, max));
    const r = Math.round(joints.clamp(Number(right) || 0, -max, max));
    this.state.drive = { left: l, right: r, cmd, speed: Math.max(Math.abs(l), Math.abs(r)) };

    if (l === 0 && r === 0) this.link.sendStop(cfg.node);
    else this.link.sendDrive(cfg.node, l, r);

    this.onChange({ type: 'drive', drive: this.state.drive });
    this.onAction({ kind: 'drive', left: l, right: r });
    return this.state.drive;
  }

  /**
   * Joystick / tablet thumbpad: x and y in -1..1 mixed into a differential pair.
   */
  driveVector(x, y, scale = 1) {
    const cfg = this.setup.drive;
    const max = (cfg.maxPwm || 1023) * joints.clamp(scale, 0, 1);
    const fx = joints.clamp(Number(x) || 0, -1, 1);
    const fy = joints.clamp(Number(y) || 0, -1, 1);
    const left = (fy + fx) * max;
    const right = (fy - fx) * max;
    const peak = Math.max(Math.abs(left), Math.abs(right), max);
    return this.driveRaw((left / peak) * max, (right / peak) * max, 'vector');
  }

  // ------------------------------------------------------------ aux motor --

  /**
   * The single reversible motor on the right-hand board — an L298N driven by
   * direction alone (HIGH/LOW, no PWM), so there is nothing to set but a sign:
   *
   *   dir  +1  clockwise      ("up" button)
   *   dir  -1  anticlockwise  ("down" button)
   *   dir   0  stop           (button released)
   *
   * Like the base, this is hold-to-run: the firmware stops on its own if no
   * command arrives inside `failsafeMs`, so a closed browser tab cannot leave
   * the motor spinning.
   */
  setMotor(dir) {
    const cfg = this.setup.motor;
    if (!cfg) throw new Error('no motor section in setup.json');

    // What the UI asked for — that is what the recorder and the readout mean.
    const requested = this.state.estop ? 0 : Math.sign(Number(dir) || 0);
    // What goes on the wire, once a mirrored wiring job is accounted for.
    const wire = cfg.invert ? -requested : requested;

    this.state.motor = {
      dir: requested,
      cmd: requested === 0 ? (this.state.estop ? 'estop' : 'stop') : requested > 0 ? 'cw' : 'ccw',
    };

    if (wire === 0) this.link.sendMotorStop(cfg.node);
    else this.link.sendMotor(cfg.node, wire);

    this.onChange({ type: 'motor', motor: this.state.motor });
    this.onAction({ kind: 'motor', dir: requested });
    return this.state.motor;
  }

  /** cmd: up (clockwise) | down (anticlockwise) | stop */
  motorCommand(cmd) {
    const dir = cmd === 'up' ? 1 : cmd === 'down' ? -1 : cmd === 'stop' ? 0 : null;
    if (dir === null) throw new Error(`unknown motor command "${cmd}"`);
    return this.setMotor(dir);
  }

  // ----------------------------------------------------------------- eyes --

  /**
   * The animated eyes on the phone face. Pure display state — it drives no
   * servo, so there is no node to address and nothing to rate-limit; it is
   * simply held here and mirrored to every connected client, which is what
   * lets the control UI move eyes that are being drawn on a different device.
   *
   * Accepts a partial patch; anything absent keeps its current value.
   */
  setEyes(patch = {}) {
    const cur = this.state.eyes;
    const num = (v, lo, hi, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
    };

    const next = {
      look: patch.look != null ? num(patch.look, -100, 100, cur.look) : cur.look,
      swing: patch.swing != null ? !!patch.swing : cur.swing,
      lids: patch.lids === 'open' || patch.lids === 'closed' ? patch.lids : cur.lids,
      speed: patch.speed != null ? num(patch.speed, 1, 100, cur.speed) : cur.speed,
      blink: patch.blink != null ? !!patch.blink : cur.blink,
      auto: patch.auto != null ? !!patch.auto : cur.auto,
    };

    // Aiming the eyes by hand means you no longer want them wandering off.
    if (patch.look != null) { next.swing = patch.swing != null ? next.swing : false; next.auto = false; }
    if (patch.swing) next.auto = false;

    this.state.eyes = next;
    this.onChange({ type: 'eyes', eyes: next });
    this.onAction({ kind: 'eyes', eyes: next });
    return next;
  }

  // ------------------------------------------------------------------ stop --

  emergencyStop(on = true) {
    this.state.estop = !!on;
    if (this.state.estop) {
      this.driveRaw(0, 0, 'estop');
      if (this.setup.motor) this.setMotor(0);
    } else if (this.setup.motor && this.state.motor.cmd === 'estop') {
      // Releasing the stop clears the "blocked" label. Relabel rather than
      // re-command: the motor is already parked, and nothing should start
      // turning just because somebody un-armed the button.
      this.state.motor = { dir: 0, cmd: 'stop' };
      this.onChange({ type: 'motor', motor: this.state.motor });
    }
    this.onChange({ type: 'estop', estop: this.state.estop });
    return this.state.estop;
  }

  // --------------------------------------------------------------- private --

  _queue(nodeId, channel, angle) {
    if (!this.pending.has(nodeId)) this.pending.set(nodeId, {});
    this.pending.get(nodeId)[channel] = angle;
  }

  _schedule() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._flush();
    }, this.minIntervalMs);
    // Try immediately too; _flush respects the per-node rate limit.
    this._flush();
  }

  _flush(force = false) {
    const now = Date.now();
    for (const [nodeId, channels] of [...this.pending.entries()]) {
      const last = this.lastSent.get(nodeId) || 0;
      if (!force && now - last < this.minIntervalMs) continue;
      this.link.sendServos(nodeId, channels);
      this.lastSent.set(nodeId, now);
      this.pending.delete(nodeId);
    }
    if (this.pending.size && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this._flush();
      }, this.minIntervalMs);
    }
  }
}

module.exports = { Controller };
