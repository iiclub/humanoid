'use strict';

/**
 * Scripted motions that span more than one subsystem.
 *
 * The wake sequence walks the head servo on D4 (head_tilt, channel 5 of the
 * left-hand board) from 0 to 70 degrees, and part-way through that travel it
 * starts the eyes opening. The overlap is the whole point: the lids begin to
 * lift while the head is still moving, which reads as waking up. Two separate
 * button presses could never be timed closely enough by hand.
 *
 * It runs here rather than in the browser so that closing the tab does not
 * abandon the robot mid-motion, and so the timing does not depend on a phone's
 * animation frames.
 */

/* head_tilt is declared with initial: 180, so travel 0 sits at 180 degrees and
   travel 100 sits at 0. The sequence is written in degrees because that is how
   it was asked for, and converted once, here, where the mapping is visible. */
const TILT_JOINT = 'head_tilt';
const degToTravel = (deg) => ((180 - deg) / 180) * 100;

/* Mirrors speedMs(speed, 4000, 70) in frontend/js/face.js, which turns the
   1..100 eye-speed setting into a lid transition duration. The sequence needs
   the inverse — "which speed setting makes the lids take about this long?" —
   so if that range changes in face.js it must change here too. */
const LID_SLOWEST_MS = 4000;
const LID_FASTEST_MS = 70;

function msToSpeed(ms) {
  const clamped = Math.max(LID_FASTEST_MS, Math.min(LID_SLOWEST_MS, ms));
  const t = (LID_SLOWEST_MS - clamped) / (LID_SLOWEST_MS - LID_FASTEST_MS);
  return Math.max(1, Math.min(100, Math.round(1 + t * 99)));
}

class Sequencer {
  constructor({ controller, state, log = () => {} }) {
    this.controller = controller;
    this.state = state;
    this.log = log;

    this.timer = null;
    this.running = null;      // name of the sequence in flight
    this.token = 0;           // invalidates timers from a superseded run
  }

  status() {
    return { running: this.running };
  }

  stop(reason = 'stopped') {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) this.log('http', `sequence "${this.running}" ${reason}`);
    this.running = null;
    this.token++;
    return this.status();
  }

  /**
   * Head travels from `fromDeg` to `toDeg`; the eyes start opening as it
   * passes `openAtDeg`.
   *
   * `openAtDeg` defaults to the midpoint of whatever range it is given, rather
   * than a fixed angle — a hardcoded trigger silently never fires if it falls
   * outside the endpoints, and the eyes would then only open at the very end.
   *
   * durationMs covers the head movement. The eyes are given the remaining time
   * to open in, so the two finish together however long the head is set to
   * take — a fixed lid duration would either beat the head or lag behind it.
   */
  wake({ fromDeg = 0, toDeg = 70, openAtDeg = null, durationMs = 20000 } = {}) {
    if (openAtDeg == null) openAtDeg = (Number(fromDeg) + Number(toDeg)) / 2;
    this.stop('superseded');

    const token = ++this.token;
    this.running = 'wake';

    const total = Math.max(1000, Math.min(180000, Number(durationMs) || 20000));
    const span = fromDeg - toDeg;

    // Eyes shut and held still before anything moves — there is nothing to open
    // otherwise, and a wandering gaze would undercut the effect.
    this.controller.setEyes({ lids: 'closed', look: 0, swing: false, auto: false, speed: 60 });
    this.controller.setJoint(TILT_JOINT, degToTravel(fromDeg));

    this.log('http', `sequence "wake": head ${fromDeg} -> ${toDeg} deg over ${total} ms, eyes open at ${openAtDeg}`);

    const started = Date.now();
    let eyesOpened = false;
    const STEP_MS = 60;                       // ~16 Hz, well under the 25 Hz cap

    this.timer = setInterval(() => {
      if (token !== this.token) return;       // a newer run owns the robot now

      if (this.state.estop) {
        this.stop('halted by E-STOP');
        return;
      }

      const t = Math.min(1, (Date.now() - started) / total);
      const deg = fromDeg - span * t;

      try {
        this.controller.setJoint(TILT_JOINT, degToTravel(deg));
      } catch (err) {
        this.log('warn', `sequence "wake": ${err.message}`);
        this.stop('failed');
        return;
      }

      /* Crossing the trigger angle. `span > 0` guards the comparison so this
         still works if someone runs the sequence upward, 0 -> 180. */
      const passed = span > 0 ? deg <= openAtDeg : deg >= openAtDeg;
      if (!eyesOpened && passed) {
        eyesOpened = true;
        const remaining = Math.max(400, total * (1 - t));
        // Pick the eye-speed setting whose lid duration best fills the time
        // that is left, so head and eyes arrive together.
        const speed = msToSpeed(remaining);
        this.controller.setEyes({ lids: 'open', speed });
        this.log('http', `sequence "wake": passed ${openAtDeg} deg — opening eyes over ~${Math.round(remaining)} ms`);
      }

      if (t >= 1) {
        // Make sure the eyes end up open even if the trigger angle was never
        // between the endpoints.
        if (!eyesOpened) this.controller.setEyes({ lids: 'open', speed: 10 });
        this.controller.setEyes({ auto: true });     // hand the gaze back
        this.stop('finished');
      }
    }, STEP_MS);

    return this.status();
  }
}

module.exports = { Sequencer, degToTravel, msToSpeed };
