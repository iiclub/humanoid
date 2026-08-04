/** Mirror of backend/src/joints.js so the UI can show the exact servo angle
 *  that the firmware will receive. Keep the two in sync if you change one. */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function travelToAngle(joint, travel) {
  const t = clamp(Number(travel) || 0, 0, 100);
  const span = joint.max - joint.min;
  const startsAtMin = joint.initial === joint.min;

  let angle = startsAtMin ? joint.min + (span * t) / 100 : joint.max - (span * t) / 100;
  if (joint.direction === -1) angle = joint.min + joint.max - angle;
  angle += joint.trim || 0;
  return Math.round(clamp(angle, joint.min, joint.max));
}

export function angleToTravel(joint, angle) {
  let a = clamp(Number(angle) || 0, joint.min, joint.max) - (joint.trim || 0);
  if (joint.direction === -1) a = joint.min + joint.max - a;
  const span = joint.max - joint.min;
  const startsAtMin = joint.initial === joint.min;
  const t = startsAtMin ? ((a - joint.min) * 100) / span : ((joint.max - a) * 100) / span;
  return Math.round(clamp(t, 0, 100));
}
