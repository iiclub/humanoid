'use strict';

/**
 * Travel <-> servo-angle mapping.
 *
 * The UI never speaks in raw servo degrees. It speaks in TRAVEL: 0..100 %.
 *
 *   travel   0   = the joint sits at its declared HOME (`initial`, which is min or max)
 *   travel 100   = the joint has moved all the way to the opposite end
 *
 * So a joint declared `initial: 0`   runs   0 -> 180
 * and a joint declared `initial: 180` runs 180 -> 0.
 *
 * `direction: -1` mirrors the final angle around the mid-point. That is the knob
 * you turn when a servo is physically mounted the other way round (e.g. the left
 * arm mirrors the right one) and you do NOT want to rewrite the whole pose table.
 *
 * `trim` is added last, to compensate for horn-spline offset, then clamped.
 */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function travelToAngle(joint, travel) {
  const t = clamp(Number(travel) || 0, 0, 100);
  const span = joint.max - joint.min;
  const startsAtMin = joint.initial === joint.min;

  let angle = startsAtMin
    ? joint.min + (span * t) / 100
    : joint.max - (span * t) / 100;

  if (joint.direction === -1) {
    angle = joint.min + joint.max - angle;
  }

  angle += joint.trim || 0;
  return Math.round(clamp(angle, joint.min, joint.max));
}

function angleToTravel(joint, angle) {
  let a = clamp(Number(angle) || 0, joint.min, joint.max) - (joint.trim || 0);
  if (joint.direction === -1) a = joint.min + joint.max - a;

  const span = joint.max - joint.min;
  const startsAtMin = joint.initial === joint.min;
  const t = startsAtMin ? ((a - joint.min) * 100) / span : ((joint.max - a) * 100) / span;
  return Math.round(clamp(t, 0, 100));
}

/** Degrees used purely for drawing the 3D / stick figure — independent of wiring. */
function travelToViz(joint, travel) {
  const t = clamp(Number(travel) || 0, 0, 100);
  const [a, b] = joint.vizRange || [0, 180];
  return a + ((b - a) * t) / 100;
}

function byId(setup) {
  const map = new Map();
  for (const j of setup.joints) map.set(j.id, j);
  return map;
}

function homePose(setup) {
  const pose = {};
  for (const j of setup.joints) pose[j.id] = 0; // travel 0 == the declared initial angle
  return pose;
}

module.exports = { clamp, travelToAngle, angleToTravel, travelToViz, byId, homePose };
