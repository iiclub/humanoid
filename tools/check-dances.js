#!/usr/bin/env node
'use strict';

/**
 * Do the routines actually look different from each other?
 *
 * Reads config/dances.json, flattens every routine into its arm poses, and
 * counts how many of one routine's poses are near-duplicates of another's.
 * Two routines that share more than MAX_SHARED of their poses fail — that is
 * the "these two songs have the same steps" complaint, caught before a demo
 * rather than during one.
 *
 * ponytail: nearest-neighbour on six joint numbers, no clustering, no DTW.
 * Upgrade to a sequence distance if same poses in a different ORDER starts
 * counting as "the same dance" — it does not, today.
 *
 * Usage:  node tools/check-dances.js        exit 1 on any failing pair
 */

const fs = require('fs');
const path = require('path');

const ARMS = ['right_shoulder_x', 'right_shoulder_y', 'right_elbow', 'left_shoulder_x', 'left_shoulder_y', 'left_elbow'];
const NEAR = 14;          // travel-% per joint inside which two poses count as the same
const MAX_SHARED = 0.45;  // more than this fraction shared between two routines fails

const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config', 'dances.json'), 'utf8'));

/* A routine's arm poses, each carried forward from the last — a step that
   only moves the head still HAS an arm pose, it is the previous one. */
function posesOf(dance) {
  const cur = Object.fromEntries(ARMS.map((j) => [j, 0]));
  const out = [];
  const walk = (steps) => {
    for (const s of steps) {
      if (!s || typeof s !== 'object') continue;
      if (s.repeat) { for (let i = 0; i < s.repeat; i++) walk(s.steps || []); continue; }
      let moved = false;
      for (const j of ARMS) if (s.pose && s.pose[j] != null) { cur[j] = s.pose[j]; moved = true; }
      if (moved) out.push(ARMS.map((j) => cur[j]));
    }
  };
  walk(dance.steps);
  return out;
}

const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= NEAR);

/** Fraction of A's poses that have a near-twin somewhere in B. */
function shared(A, B) {
  if (!A.length) return 0;
  let n = 0;
  for (const p of A) if (B.some((q) => near(p, q))) n++;
  return n / A.length;
}

const dances = raw.dances.map((d) => ({ id: d.id, poses: posesOf(d) }));
let bad = 0;
console.log(`${dances.length} routines · a pair fails above ${Math.round(MAX_SHARED * 100)}% shared poses (±${NEAR}%)\n`);
for (let i = 0; i < dances.length; i++) {
  for (let k = i + 1; k < dances.length; k++) {
    const a = dances[i]; const b = dances[k];
    const s = Math.max(shared(a.poses, b.poses), shared(b.poses, a.poses));
    const fail = s > MAX_SHARED;
    if (fail) bad++;
    console.log(`${fail ? 'FAIL' : ' ok '}  ${a.id.padEnd(18)} ${b.id.padEnd(18)} ${Math.round(s * 100).toString().padStart(3)}% shared`);
  }
}
console.log(bad ? `\n${bad} pair(s) too alike` : '\nall distinct');
process.exit(bad ? 1 : 0);
