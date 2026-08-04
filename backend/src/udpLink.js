'use strict';

const dgram = require('dgram');
const os = require('os');
const EventEmitter = require('events');

/**
 * Wire protocol (plain ASCII, one datagram = one message, '|' separated tokens).
 *
 *   backend -> node   S|seq=42|0=90|2=140      set servo channel 0 to 90 deg, ch 2 to 140
 *   backend -> node   D|seq=42|l=900|r=-900    differential drive, -1023..1023 per side
 *   backend -> node   D|stop=1                 immediate stop
 *   backend -> node   M|seq=42|dir=1           aux motor: +1 clockwise, -1 anticlockwise, 0 stop
 *   backend -> node   P|                       ping
 *   backend -> bcast  SRV|ip=192.168.1.20|port=4211|http=3000   "the laptop lives here"
 *
 *   node -> backend   B|id=right_hand|ip=192.168.1.31|rssi=-54|up=120345    heartbeat
 *   node -> backend   A|id=right_hand|seq=42                                 ack
 *
 * Deliberately text based: it is trivial to parse on an ESP8266 without
 * ArduinoJson, and trivial to eyeball with `nc -ul 4211` while debugging.
 */

function localIPv4() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const list of Object.values(ifaces)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push(net.address);
    }
  }
  // Prefer a private LAN address (the robot lives on the same subnet).
  const priv = candidates.find((ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  return priv || candidates[0] || '127.0.0.1';
}

function encode(type, fields) {
  const parts = [type];
  for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${v}`);
  return Buffer.from(parts.join('|'));
}

function decode(buf) {
  const text = buf.toString('utf8').trim();
  const [type, ...rest] = text.split('|');
  const fields = {};
  for (const token of rest) {
    if (!token) continue;
    const i = token.indexOf('=');
    if (i === -1) continue;
    fields[token.slice(0, i)] = token.slice(i + 1);
  }
  return { type, fields, raw: text };
}

class UdpLink extends EventEmitter {
  constructor(setup, state) {
    super();
    this.setup = setup;
    this.state = state;
    this.seq = 0;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.nodePort = setup.network.nodeUdpPort;
    this.myPort = setup.network.backendUdpPort;
    this.broadcastAddress = setup.network.broadcastAddress || '255.255.255.255';
    this.announceTimer = null;
  }

  start() {
    this.socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    this.socket.on('error', (err) => this.emit('log', { level: 'error', msg: `UDP error: ${err.message}` }));

    return new Promise((resolve) => {
      this.socket.bind(this.myPort, () => {
        this.socket.setBroadcast(true);
        this.emit('log', { level: 'info', msg: `UDP listening on ${localIPv4()}:${this.myPort}` });
        const every = this.setup.network.announceIntervalMs || 3000;
        this.announceTimer = setInterval(() => this.announce(), every);
        this.announce();
        resolve();
      });
    });
  }

  stop() {
    if (this.announceTimer) clearInterval(this.announceTimer);
    try { this.socket.close(); } catch { /* already closed */ }
  }

  /**
   * Broadcast where the backend is. Nodes that were flashed before the laptop
   * changed IP pick this up and re-register without touching the captive portal.
   */
  announce() {
    const pkt = encode('SRV', {
      ip: localIPv4(),
      port: this.myPort,
      http: this.setup.network.httpPort,
    });
    this.socket.send(pkt, 0, pkt.length, this.nodePort, this.broadcastAddress, (err) => {
      if (err) this.emit('log', { level: 'warn', msg: `announce failed: ${err.message}` });
    });
  }

  sendTo(nodeId, type, fields) {
    const dev = this.state.devices.get(nodeId);
    if (!dev || !dev.ip) {
      this.emit('log', { level: 'warn', msg: `no IP known for node "${nodeId}" — command dropped` });
      return false;
    }
    const seq = ++this.seq;
    const pkt = encode(type, { seq, ...fields });
    const port = dev.udpPort || this.nodePort;
    this.socket.send(pkt, 0, pkt.length, port, dev.ip, (err) => {
      if (err) this.emit('log', { level: 'warn', msg: `send to ${nodeId} failed: ${err.message}` });
    });
    dev.packetsOut++;
    this.emit('tx', { nodeId, ip: dev.ip, text: pkt.toString() });
    return true;
  }

  /** channels: { "<channel>": angle } */
  sendServos(nodeId, channels) {
    if (!Object.keys(channels).length) return false;
    return this.sendTo(nodeId, 'S', channels);
  }

  sendDrive(nodeId, left, right) {
    return this.sendTo(nodeId, 'D', { l: Math.round(left), r: Math.round(right) });
  }

  sendStop(nodeId) {
    return this.sendTo(nodeId, 'D', { stop: 1, l: 0, r: 0 });
  }

  /** Aux motor (L298N, direction only): dir -1 / 0 / +1. */
  sendMotor(nodeId, dir) {
    return this.sendTo(nodeId, 'M', { dir: Math.sign(dir) || 0 });
  }

  sendMotorStop(nodeId) {
    return this.sendTo(nodeId, 'M', { dir: 0, stop: 1 });
  }

  _onMessage(msg, rinfo) {
    const { type, fields, raw } = decode(msg);
    this.emit('rx', { ip: rinfo.address, text: raw });

    if (type === 'B' || type === 'A') {
      const id = fields.id;
      if (!id || !this.state.devices.has(id)) return;
      this.state.touchDevice(id, {
        ip: fields.ip || rinfo.address,
        /* Trust where the packet actually came from. Both the firmware and the
           simulator send from the socket they listen on, so this self-heals a
           stale port within one heartbeat instead of waiting for a re-register. */
        udpPort: type === 'B' ? rinfo.port : undefined,
        rssi: fields.rssi != null ? Number(fields.rssi) : undefined,
        fw: fields.fw || undefined,
        uptime: fields.up != null ? Number(fields.up) : undefined,
      });
      this.emit('heartbeat', { id, ip: rinfo.address, type });
    }
  }
}

module.exports = { UdpLink, localIPv4, encode, decode };
