'use strict';

const fs = require('fs');
const path = require('path');

const SETUP_PATH = path.resolve(__dirname, '..', '..', 'config', 'setup.json');

let cache = null;

function load(force = false) {
  if (cache && !force) return cache;
  const raw = fs.readFileSync(SETUP_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  validate(parsed);
  cache = parsed;
  return cache;
}

function save(next) {
  validate(next);
  fs.writeFileSync(SETUP_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  cache = next;
  return cache;
}

function validate(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('setup.json must be an object');
  if (!cfg.network) throw new Error('setup.json: missing "network"');
  if (!cfg.nodes) throw new Error('setup.json: missing "nodes"');
  if (!Array.isArray(cfg.joints)) throw new Error('setup.json: "joints" must be an array');

  const seenIds = new Set();
  const seenChannels = new Set();

  for (const j of cfg.joints) {
    if (!j.id) throw new Error('setup.json: a joint has no "id"');
    if (seenIds.has(j.id)) throw new Error(`setup.json: duplicate joint id "${j.id}"`);
    seenIds.add(j.id);

    if (!cfg.nodes[j.node]) throw new Error(`joint "${j.id}" references unknown node "${j.node}"`);
    if (!Number.isInteger(j.channel) || j.channel < 0) {
      throw new Error(`joint "${j.id}" needs an integer "channel" >= 0`);
    }
    const key = `${j.node}:${j.channel}`;
    if (seenChannels.has(key)) throw new Error(`setup.json: channel ${j.channel} used twice on node "${j.node}"`);
    seenChannels.add(key);

    if (j.min >= j.max) throw new Error(`joint "${j.id}": "min" must be smaller than "max"`);
    if (j.initial !== j.min && j.initial !== j.max) {
      throw new Error(`joint "${j.id}": "initial" must equal min (${j.min}) or max (${j.max}) — motion always starts at one end`);
    }
    if (j.direction !== 1 && j.direction !== -1) {
      throw new Error(`joint "${j.id}": "direction" must be 1 or -1`);
    }
  }

  if (cfg.drive && !cfg.nodes[cfg.drive.node]) {
    throw new Error(`drive references unknown node "${cfg.drive.node}"`);
  }

  if (cfg.motor) {
    if (!cfg.nodes[cfg.motor.node]) {
      throw new Error(`motor references unknown node "${cfg.motor.node}"`);
    }
    if (!cfg.motor.pinCw || !cfg.motor.pinCcw) {
      throw new Error('motor needs both "pinCw" and "pinCcw"');
    }
    if (cfg.motor.pinCw === cfg.motor.pinCcw) {
      throw new Error('motor "pinCw" and "pinCcw" must be different pins');
    }
    // A servo and the motor bridge cannot share a pin on the same board.
    const taken = cfg.joints.filter((j) => j.node === cfg.motor.node).map((j) => j.pin);
    for (const pin of [cfg.motor.pinCw, cfg.motor.pinCcw]) {
      if (taken.includes(pin)) {
        throw new Error(`motor pin ${pin} is already used by a servo on node "${cfg.motor.node}"`);
      }
    }
  }
}

module.exports = { load, save, validate, SETUP_PATH };
