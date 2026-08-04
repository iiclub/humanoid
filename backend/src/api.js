'use strict';

const express = require('express');
const setupStore = require('./setup');
const joints = require('./joints');
const { localIPv4 } = require('./udpLink');

function buildApi({ setup, state, link, controller, recorder, sequencer, broadcast }) {
  const router = express.Router();

  const ok = (res, data) => res.json({ ok: true, ...data });
  const fail = (res, code, msg) => res.status(code).json({ ok: false, error: msg });

  // ------------------------------------------------------------ discovery --

  /**
   * Called by every NodeMCU right after it joins the user's WiFi.
   * body: { id, ip, mac, fw, rssi }
   */
  router.post('/register', (req, res) => {
    const { id, ip, mac, fw, rssi, udpPort } = req.body || {};
    if (!id) return fail(res, 400, 'missing "id"');
    if (!state.devices.has(id)) return fail(res, 404, `unknown node id "${id}"`);

    const reportedIp = ip || req.ip?.replace('::ffff:', '') || null;
    const dev = state.registerDevice(id, { ip: reportedIp, mac, fw, rssi, udpPort });
    broadcast({ type: 'devices', devices: state.deviceList() });

    // A node that just registered has servos parked at their power-on angle,
    // so push the current pose straight back at it.
    setTimeout(() => controller.resync(id), 300);

    return ok(res, {
      device: dev,
      server: {
        ip: localIPv4(),
        udpPort: setup.network.backendUdpPort,
        commandPort: setup.network.nodeUdpPort,
        httpPort: setup.network.httpPort,
      },
      time: Date.now(),
    });
  });

  router.get('/devices', (_req, res) => ok(res, { devices: state.deviceList(), server: { ip: localIPv4() } }));

  /** Manually pin an IP (handy while a node is still being flashed). */
  router.post('/devices/:id/ip', (req, res) => {
    const { id } = req.params;
    if (!state.devices.has(id)) return fail(res, 404, 'unknown node');
    const dev = state.devices.get(id);
    dev.ip = req.body?.ip || null;
    broadcast({ type: 'devices', devices: state.deviceList() });
    return ok(res, { device: dev });
  });

  router.post('/devices/:id/resync', (req, res) => {
    if (!state.devices.has(req.params.id)) return fail(res, 404, 'unknown node');
    controller.resync(req.params.id);
    return ok(res, {});
  });

  router.post('/announce', (_req, res) => {
    link.announce();
    return ok(res, { server: { ip: localIPv4() } });
  });

  // ---------------------------------------------------------------- state --

  router.get('/state', (_req, res) => ok(res, { state: state.snapshot() }));

  router.get('/setup', (_req, res) => ok(res, { setup }));

  router.put('/setup', (req, res) => {
    try {
      const next = setupStore.save(req.body);
      return ok(res, { setup: next, note: 'restart the server to apply network/pin changes' });
    } catch (err) {
      return fail(res, 400, err.message);
    }
  });

  /** Live-tune one joint's calibration without a full setup.json PUT. */
  router.patch('/setup/joints/:id', (req, res) => {
    const joint = setup.joints.find((j) => j.id === req.params.id);
    if (!joint) return fail(res, 404, 'unknown joint');
    const allowed = ['direction', 'initial', 'trim', 'min', 'max', 'speed', 'vizRange', 'label'];
    for (const key of allowed) {
      if (key in (req.body || {})) joint[key] = req.body[key];
    }
    try {
      setupStore.validate(setup);
      setupStore.save(setup);
    } catch (err) {
      return fail(res, 400, err.message);
    }
    controller.setJoint(joint.id, state.pose[joint.id] ?? 0);
    broadcast({ type: 'setup', setup });
    return ok(res, { joint });
  });

  // --------------------------------------------------------------- motion --

  router.post('/joint', (req, res) => {
    const { id, travel, angle } = req.body || {};
    const joint = setup.joints.find((j) => j.id === id);
    if (!joint) return fail(res, 404, `unknown joint "${id}"`);
    const t = angle != null ? joints.angleToTravel(joint, angle) : travel;
    try {
      return ok(res, { result: controller.setJoint(id, t) });
    } catch (err) {
      return fail(res, 400, err.message);
    }
  });

  router.post('/pose', (req, res) => {
    const body = req.body || {};
    try {
      if (body.name) return ok(res, { results: controller.applyNamedPose(body.name) });
      return ok(res, { results: controller.setPose(body.pose || body) });
    } catch (err) {
      return fail(res, 400, err.message);
    }
  });

  router.post('/home', (_req, res) => ok(res, { results: controller.goHome() }));

  // ---------------------------------------------------------------- drive --

  router.post('/drive', (req, res) => {
    const { cmd, speed, left, right, x, y, scale } = req.body || {};
    try {
      if (x != null || y != null) return ok(res, { drive: controller.driveVector(x, y, scale ?? 1) });
      if (left != null || right != null) return ok(res, { drive: controller.driveRaw(left, right) });
      return ok(res, { drive: controller.drive(cmd || 'stop', speed) });
    } catch (err) {
      return fail(res, 400, err.message);
    }
  });

  // ------------------------------------------------------------ aux motor --

  /** { cmd: 'up' | 'down' | 'stop' } or { dir: 1 | -1 | 0 } */
  router.post('/motor', (req, res) => {
    const { cmd, dir } = req.body || {};
    try {
      if (dir != null) return ok(res, { motor: controller.setMotor(dir) });
      return ok(res, { motor: controller.motorCommand(cmd || 'stop') });
    } catch (err) {
      return fail(res, 400, err.message);
    }
  });

  /** { look, swing, lids, speed, auto } — any subset. */
  router.post('/eyes', (req, res) => {
    try { return ok(res, { eyes: controller.setEyes(req.body || {}) }); }
    catch (err) { return fail(res, 400, err.message); }
  });

  /**
   * Scripted head-and-eyes wake. Body may override fromDeg / toDeg / openAtDeg
   * / durationMs; the defaults are the sequence as specified: D6 from 180 to 0,
   * eyes starting to open as it passes 90.
   */
  router.post('/sequence/wake', (req, res) => {
    if (!sequencer) return fail(res, 503, 'no sequencer');
    try { return ok(res, { sequence: sequencer.wake(req.body || {}) }); }
    catch (err) { return fail(res, 400, err.message); }
  });

  router.post('/sequence/stop', (_req, res) => ok(res, { sequence: sequencer.stop() }));
  router.get('/sequence', (_req, res) => ok(res, { sequence: sequencer.status() }));

  router.post('/estop', (req, res) => ok(res, { estop: controller.emergencyStop(req.body?.on ?? true) }));

  // ------------------------------------------------------ record / play back --

  const rec = (fn) => (req, res) => {
    try { return ok(res, { record: fn(req) }); }
    catch (err) { return fail(res, 400, err.message); }
  };

  router.get('/record', (_req, res) => ok(res, { record: recorder.status() }));
  router.post('/record/start', rec(() => recorder.startRecording()));
  router.post('/record/stop', rec(() => recorder.stopRecording()));
  router.post('/record/clear', rec(() => recorder.clear()));
  router.post('/record/play', rec((req) => recorder.play({ loop: req.body?.loop ?? false })));
  router.post('/record/stopplay', rec(() => recorder.stopPlayback()));
  router.post('/record/save', rec((req) => recorder.save(req.body?.name)));
  router.post('/record/load', rec((req) => recorder.load(req.body?.name)));
  router.delete('/record/:name', rec((req) => recorder.remove(req.params.name)));

  return router;
}

module.exports = { buildApi };
