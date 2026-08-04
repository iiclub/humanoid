#!/usr/bin/env node
'use strict';

/**
 * Virtual NodeMCUs — lets you exercise the whole stack with no hardware.
 *
 *   node tools/sim-node.js                 # all three nodes
 *   node tools/sim-node.js right_hand      # just one
 *
 * Each fake node registers over HTTP exactly like the firmware does, listens
 * for UDP servo/drive packets, sends heartbeats back, and prints what it would
 * have written to its pins.
 */

const dgram = require('dgram');
const http = require('http');
const path = require('path');
const setup = require(path.resolve(__dirname, '..', 'config', 'setup.json'));

const HOST = process.env.SERVER || '127.0.0.1';
const HTTP_PORT = setup.network.httpPort;
const BACKEND_UDP = setup.network.backendUdpPort;
const BASE_PORT = Number(process.env.SIM_BASE_PORT || 4310);

const wanted = process.argv.slice(2);
const ids = (wanted.length ? wanted : Object.keys(setup.nodes)).filter((id) => setup.nodes[id]);

const COLORS = { right_hand: '\x1b[36m', left_hand: '\x1b[33m', drive: '\x1b[35m' };
const RESET = '\x1b[0m';

ids.forEach((id, index) => startNode(id, BASE_PORT + index));

function startNode(id, port) {
  const color = COLORS[id] || '';
  const cfg = setup.nodes[id];
  const channels = setup.joints
    .filter((j) => j.node === id)
    .sort((a, b) => a.channel - b.channel);

  const angles = {};
  for (const j of channels) angles[j.channel] = j.initial;

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const say = (msg) => console.log(`${color}[${id}]${RESET} ${msg}`);

  sock.on('message', (buf) => {
    const text = buf.toString().trim();
    const [type, ...rest] = text.split('|');
    const fields = {};
    for (const t of rest) {
      const i = t.indexOf('=');
      if (i > 0) fields[t.slice(0, i)] = t.slice(i + 1);
    }

    if (type === 'S') {
      const moved = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!/^\d+$/.test(k)) continue;
        const ch = Number(k);
        const joint = channels.find((j) => j.channel === ch);
        angles[ch] = Number(v);
        moved.push(`${joint ? joint.pin : `ch${ch}`}=${v}°`);
      }
      if (moved.length) say(`servo  ${moved.join('  ')}`);
      ack(fields.seq);
    } else if (type === 'M') {
      setMotor(Number(fields.stop) ? 0 : Number(fields.dir) || 0);
      ack(fields.seq);
    } else if (type === 'D') {
      say(fields.stop ? 'drive  STOP' : `drive  L=${fields.l} R=${fields.r}`);
      ack(fields.seq);
    } else if (type === 'P') {
      ack(fields.seq);
    } else if (type === 'SRV') {
      // announce packet — the real firmware would store this address
    }
  });

  /* Aux motor, if this node owns one. Mirrors the firmware: one direction pin
     HIGH and the other LOW, both LOW when stopped, plus the same "no command
     inside failsafeMs -> stop" rule, so hold-to-run can be tested for real. */
  const motor = setup.motor && setup.motor.node === id ? setup.motor : null;
  let motorDir = 0;
  let motorFailsafe = null;

  function setMotor(dir) {
    if (!motor) return;
    if (motorFailsafe) clearTimeout(motorFailsafe);
    motorFailsafe = null;

    if (dir !== motorDir) {
      say(dir === 0
        ? `motor  STOP       ${motor.pinCw}=LOW  ${motor.pinCcw}=LOW`
        : dir > 0
          ? `motor  CLOCKWISE ${motor.pinCw}=HIGH ${motor.pinCcw}=LOW`
          : `motor  ANTICLOCK ${motor.pinCw}=LOW  ${motor.pinCcw}=HIGH`);
    }
    motorDir = dir;

    if (dir !== 0) {
      motorFailsafe = setTimeout(() => {
        motorDir = 0;
        say(`motor  FAILSAFE   no command for ${motor.failsafeMs || 600} ms — stopped`);
      }, motor.failsafeMs || 600);
    }
  }

  function ack(seq) {
    send(`A|id=${id}|seq=${seq || 0}`);
  }

  function send(msg) {
    const b = Buffer.from(msg);
    sock.send(b, 0, b.length, BACKEND_UDP, HOST);
  }

  sock.bind(port, () => {
    say(`listening on udp ${port}  (${cfg.label})`);
    register();
    setInterval(() => send(`B|id=${id}|ip=127.0.0.1|rssi=-42|up=${Math.round(process.uptime() * 1000)}|fw=sim`), 2000);
  });

  // Plain http.request rather than fetch, so the simulator runs on older Node too.
  function register() {
    const body = JSON.stringify({
      id,
      ip: '127.0.0.1',
      mac: `AA:BB:CC:00:00:0${ids.indexOf(id)}`,
      rssi: -42,
      fw: 'sim-1.0.0',
      udpPort: port,
    });

    const req = http.request(
      {
        host: HOST,
        port: HTTP_PORT,
        path: '/api/register',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          const ok = res.statusCode === 200;
          say(ok ? `registered with ${HOST}:${HTTP_PORT}` : `register failed (${res.statusCode}): ${data}`);
          if (!ok) setTimeout(register, 3000);
        });
      },
    );
    req.on('error', (err) => {
      say(`register failed (${err.message}) — retrying in 3 s`);
      setTimeout(register, 3000);
    });
    req.end(body);
  }
}

console.log(`\nsimulating: ${ids.join(', ')}\nserver: http://${HOST}:${HTTP_PORT}\n`);
