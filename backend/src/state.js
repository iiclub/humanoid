'use strict';

const EventEmitter = require('events');
const joints = require('./joints');

/**
 * In-memory robot state: which NodeMCUs have checked in, where every joint is,
 * and what the drive base was last told to do.
 */
class RobotState extends EventEmitter {
  constructor(setup) {
    super();
    this.setup = setup;
    this.devices = new Map();          // nodeId -> { id, ip, mac, fw, rssi, lastSeen, online }
    this.pose = joints.homePose(setup);
    this.drive = { left: 0, right: 0, cmd: 'stop', speed: setup.drive?.defaultSpeed ?? 900 };
    // Aux motor: dir is -1 (anticlockwise) / 0 (stopped) / +1 (clockwise).
    this.motor = { dir: 0, cmd: 'stop' };
    /* The animated eyes on the phone face (/face). Nothing here reaches a
       servo — it is display state, mirrored to every connected face. */
    this.eyes = {
      look: 0,          // -100 hard left … 0 centre … +100 hard right
      swing: false,     // sweeping side to side on their own
      lids: 'open',     // open | closed
      speed: 50,        // 1 slow … 100 fast, applies to swing and to the lids
      blink: true,      // the idle blink loop; false holds the lids still
      auto: true,       // idle saccades when nothing else is driving them
    };
    this.estop = false;

    for (const [id, node] of Object.entries(setup.nodes)) {
      this.devices.set(id, {
        id,
        label: node.label,
        ip: node.ip || null,
        mac: null,
        fw: null,
        rssi: null,
        udpPort: null,
        lastSeen: 0,
        online: false,
        packetsOut: 0,
        packetsIn: 0,
      });
    }
  }

  registerDevice(id, info) {
    const dev = this.devices.get(id);
    if (!dev) return null;
    Object.assign(dev, {
      ip: info.ip || dev.ip,
      mac: info.mac || dev.mac,
      fw: info.fw || dev.fw,
      rssi: info.rssi ?? dev.rssi,
      /* Real firmware always listens on the shared node port and sends no
         udpPort at all; the simulator reports its own so several fake nodes can
         share one machine.

         This REPLACES rather than merges, deliberately. It used to fall back to
         the stored value, so once a simulator had registered as (say)
         left_hand on port 4310, the real board taking its place could never
         clear it — the board's own registration omits the field entirely. Every
         command then went to the right IP on a port nothing was listening to,
         and the node looked online (its heartbeats still arrived) while
         silently ignoring everything. */
      udpPort: info.udpPort || null,
      lastSeen: Date.now(),
      online: true,
    });
    this.emit('devices', this.deviceList());
    return dev;
  }

  touchDevice(id, patch = {}) {
    const dev = this.devices.get(id);
    if (!dev) return null;
    const wasOnline = dev.online;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) dev[k] = v;
    }
    dev.lastSeen = Date.now();
    dev.online = true;
    dev.packetsIn++;
    if (!wasOnline) this.emit('devices', this.deviceList());
    return dev;
  }

  /** Mark devices that stopped sending heartbeats as offline. */
  sweep() {
    const timeout = this.setup.network.heartbeatTimeoutMs || 6000;
    const now = Date.now();
    let changed = false;
    for (const dev of this.devices.values()) {
      if (dev.online && now - dev.lastSeen > timeout) {
        dev.online = false;
        changed = true;
      }
    }
    if (changed) this.emit('devices', this.deviceList());
    return changed;
  }

  deviceList() {
    return [...this.devices.values()].map((d) => ({ ...d }));
  }

  ipOf(nodeId) {
    const dev = this.devices.get(nodeId);
    return dev && dev.online ? dev.ip : dev?.ip || null;
  }

  setJoint(id, travel) {
    if (!(id in this.pose)) return null;
    this.pose[id] = joints.clamp(Number(travel) || 0, 0, 100);
    return this.pose[id];
  }

  snapshot() {
    return {
      pose: { ...this.pose },
      drive: { ...this.drive },
      motor: { ...this.motor },
      eyes: { ...this.eyes },
      estop: this.estop,
      devices: this.deviceList(),
      robotName: this.setup.robotName,
    };
  }
}

module.exports = { RobotState };
