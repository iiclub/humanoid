'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { WebSocketServer } = require('ws');

const setupStore = require('./src/setup');
const { RobotState } = require('./src/state');
const { UdpLink, localIPv4 } = require('./src/udpLink');
const { Controller } = require('./src/controller');
const { Recorder } = require('./src/recorder');
const { buildApi } = require('./src/api');
const { buildFaceApi } = require('./src/face');
const { Sequencer } = require('./src/sequence');

const setup = setupStore.load();
const state = new RobotState(setup);
const link = new UdpLink(setup, state);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();
function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(text);
  }
}

const controller = new Controller({
  setup,
  state,
  link,
  onChange: broadcast,
  onAction: (evt) => recorder.capture(evt),
});

const recorder = new Recorder({
  controller,
  onStatus: (status) => broadcast({ type: 'record', record: status }),
});

const sequencer = new Sequencer({ controller, state, log: (l, m) => log(l, m) });

/* The face route posts whole JPEG frames as base64, which blows past the
   512 kb that is plenty for every robot command. Mount it first, with its own
   parser, so the small limit still guards the control API. */
app.use('/api/face', express.json({ limit: '12mb' }), buildFaceApi({ log: (l, m) => log(l, m) }));

app.use(express.json({ limit: '512kb' }));
app.use((req, _res, next) => {
  if (req.method !== 'GET') log('http', `${req.method} ${req.originalUrl}`);
  next();
});

app.use('/api', buildApi({ setup, state, link, controller, recorder, sequencer, broadcast }));

const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
const CERT_DIR = path.resolve(__dirname, '..', 'certs');

/* Clean URL for the talking head, so it can be typed on a phone without the
   .html. The static handler below would serve /face.html either way. */
app.get('/face', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'face.html')));

/* The mkcert root certificate, offered for download so a phone can trust the
   HTTPS listener without shuttling files around. Public half only — the CA
   private key never leaves ~/Library/Application Support/mkcert. */
app.get('/rootCA.pem', (_req, res) => {
  const ca = path.join(CERT_DIR, 'rootCA.pem');
  if (!fs.existsSync(ca)) return res.status(404).send('no rootCA.pem in certs/');
  res.type('application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="humanoid-rootCA.crt"');
  res.send(fs.readFileSync(ca));
});

app.use(express.static(FRONTEND_DIR));

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), ip: localIPv4() }));

function onWsConnection(ws) {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', setup, state: state.snapshot(), record: recorder.status(), server: { ip: localIPv4() } }));

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    try {
      switch (msg.type) {
        case 'joint': controller.setJoint(msg.id, msg.travel); break;
        case 'pose': msg.name ? controller.applyNamedPose(msg.name) : controller.setPose(msg.pose); break;
        case 'home': controller.goHome(); break;
        case 'drive':
          if (msg.x != null || msg.y != null) controller.driveVector(msg.x, msg.y, msg.scale ?? 1);
          else if (msg.left != null || msg.right != null) controller.driveRaw(msg.left, msg.right);
          else controller.drive(msg.cmd || 'stop', msg.speed);
          break;
        case 'motor':
          if (msg.dir != null) controller.setMotor(msg.dir);
          else controller.motorCommand(msg.cmd || 'stop');
          break;
        case 'eyes': controller.setEyes(msg.eyes || msg); break;
        case 'sequence':
          if (msg.action === 'stop') sequencer.stop();
          else sequencer.wake(msg.options || {});
          break;
        case 'estop':
          if (msg.on ?? true) sequencer.stop('halted by E-STOP');
          controller.emergencyStop(msg.on ?? true);
          break;
        case 'record':
          switch (msg.action) {
            case 'start': recorder.startRecording(); break;
            case 'stop': recorder.stopRecording(); break;
            case 'clear': recorder.clear(); break;
            case 'play': recorder.play({ loop: msg.loop ?? false }); break;
            case 'stopplay': recorder.stopPlayback(); break;
            case 'save': recorder.save(msg.name); break;
            case 'load': recorder.load(msg.name); break;
            case 'remove': recorder.remove(msg.name); break;
            default: break;
          }
          break;
        case 'ping': ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); break;
        default: break;
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', error: err.message }));
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
}

wss.on('connection', onWsConnection);

// --- logging ---------------------------------------------------------------

const logRing = [];
function log(level, msg) {
  const entry = { t: Date.now(), level, msg };
  logRing.push(entry);
  if (logRing.length > 200) logRing.shift();
  broadcast({ type: 'log', entry });
  const stamp = new Date(entry.t).toLocaleTimeString();
  console.log(`[${stamp}] ${level.padEnd(5)} ${msg}`);
}

link.on('log', (e) => log(e.level, e.msg));
link.on('tx', (e) => broadcast({ type: 'tx', ...e }));
link.on('heartbeat', ({ id, ip }) => broadcast({ type: 'devices', devices: state.deviceList(), lastBeat: { id, ip } }));

state.on('devices', (devices) => broadcast({ type: 'devices', devices }));

setInterval(() => {
  if (state.sweep()) log('warn', 'a node stopped sending heartbeats — marked offline');
}, 2000);

// --- boot ------------------------------------------------------------------

const PORT = setup.network.httpPort || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;

/**
 * The /face route needs the microphone and the camera, and phone browsers hand
 * those out only in a secure context — which a plain http:// LAN address is
 * not. So when a certificate pair is present we bring up a second listener on
 * the same Express app over TLS.
 *
 * The plain HTTP listener stays exactly as it was: the ESP8266 boards register
 * over it and have no TLS stack worth speaking of.
 */
function startHttps() {
  const certFile = path.join(CERT_DIR, 'lan-cert.pem');
  const keyFile = path.join(CERT_DIR, 'lan-key.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) return null;

  try {
    const secure = https.createServer({
      cert: fs.readFileSync(certFile),
      key: fs.readFileSync(keyFile),
    }, app);

    new WebSocketServer({ server: secure, path: '/ws' }).on('connection', onWsConnection);

    secure.on('error', (err) => log('warn', `https listener: ${err.message}`));
    secure.listen(HTTPS_PORT, '0.0.0.0', () => {
      log('info', `https up on ${localIPv4()}:${HTTPS_PORT} — /face needs this one`);
    });
    return secure;
  } catch (err) {
    log('warn', `could not start https (${err.message}) — /face will not have mic or camera`);
    return null;
  }
}

link.start().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    const ip = localIPv4();
    const secure = startHttps();
    console.log('');
    console.log(`  ${setup.robotName} control server`);
    console.log(`  simulator UI : http://${ip}:${PORT}   (open this on your tablet too)`);
    if (secure) {
      console.log(`  robot face   : https://${ip}:${HTTPS_PORT}/face   (phone — mic + camera)`);
      console.log(`  phone cert   : http://${ip}:${PORT}/rootCA.pem     (install once to trust it)`);
    } else {
      console.log(`  robot face   : no certs/ — run  npm run cert  to enable https://…/face`);
    }
    console.log(`  register API : POST http://${ip}:${PORT}/api/register`);
    console.log(`  UDP out      : -> node port ${setup.network.nodeUdpPort}`);
    console.log(`  UDP in       : <- listening on ${setup.network.backendUdpPort}`);
    console.log('');
    log('info', `server up on ${ip}:${PORT}`);
  });
});

process.on('SIGINT', () => {
  console.log('\nstopping motors and shutting down…');
  try { controller.driveRaw(0, 0, 'stop'); } catch { /* node may be gone */ }
  setTimeout(() => { link.stop(); process.exit(0); }, 150);
});
