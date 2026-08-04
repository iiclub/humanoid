/**
 * Forward kinematics for the viewer.
 *
 * Input  : pose  = { jointId: travel 0..100 }, plus the joint table from setup.json
 * Output : world-space points + bones, in centimetres, Y up, X right, Z towards
 *          the viewer (the robot faces +Z).
 *
 * This drives BOTH the 3D view and the 2D stick schematic, so the two can never
 * disagree about where the robot thinks its elbow is.
 */

const D = Math.PI / 180;

export const M = {
  ident: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  mul(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
      }
    }
    return o;
  },
  rotX(t) { const c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, c, -s, 0, s, c]; },
  rotY(t) { const c = Math.cos(t), s = Math.sin(t); return [c, 0, s, 0, 1, 0, -s, 0, c]; },
  rotZ(t) { const c = Math.cos(t), s = Math.sin(t); return [c, -s, 0, s, c, 0, 0, 0, 1]; },
  apply(m, v) {
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
  },
};

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (v, k) => [v[0] * k, v[1] * k, v[2] * k];

/** Body proportions, centimetres. Tweak freely — everything else follows. */
export const DIM = {
  // wheeled base
  wheelRadius: 7,
  wheelWidth: 5,        // tyre thickness along the axle (X)
  wheelTrack: 15,       // half distance between left/right wheels (X)
  wheelBase: 12,        // half distance between front/rear wheels (Z)
  platformTop: 21,
  platformBot: 12,
  platformHalfW: 12,
  platformHalfD: 11,
  // torso
  pelvis: 27,
  chest: 43,
  shoulderY: 52,
  shoulderX: 14,        // half shoulder width
  neckY: 55,
  neckLen: 6,
  headRadius: 8,
  // arms — kept short enough that hands hang to about hip level, not the floor
  upperArm: 16,
  foreArm: 13,
  hand: 5,
  finger: 4,
};

/** travel (0..100) -> display degrees, using each joint's vizRange. */
export function vizDeg(setup, pose, id) {
  const j = setup.joints.find((x) => x.id === id);
  if (!j) return 0;
  const t = Math.max(0, Math.min(100, Number(pose?.[id] ?? 0)));
  const [a, b] = j.vizRange || [0, 180];
  return a + ((b - a) * t) / 100;
}

function armChain(setup, pose, side) {
  const s = side === 'right' ? 1 : -1;
  const prefix = side === 'right' ? 'right' : 'left';

  const flex = vizDeg(setup, pose, `${prefix}_shoulder_x`) * D;   // forward swing
  const abd = vizDeg(setup, pose, `${prefix}_shoulder_y`) * D;    // out to the side
  const elbow = vizDeg(setup, pose, `${prefix}_elbow`) * D;
  const roll = vizDeg(setup, pose, `${prefix}_wrist_z`) * D;
  const grip = vizDeg(setup, pose, `${prefix}_gripper`) * D;

  const down = [0, -1, 0];

  const shoulder = [s * DIM.shoulderX, DIM.shoulderY, 0];
  const R1 = M.mul(M.rotZ(s * abd), M.rotX(-flex));
  const elbowPt = add(shoulder, scale(M.apply(R1, down), DIM.upperArm));

  const R2 = M.mul(R1, M.rotX(-elbow));
  const wristPt = add(elbowPt, scale(M.apply(R2, down), DIM.foreArm));

  const R3 = M.mul(R2, M.rotY(roll));
  const palmPt = add(wristPt, scale(M.apply(R3, down), DIM.hand));

  const fA = add(palmPt, scale(M.apply(M.mul(R3, M.rotZ(grip)), down), DIM.finger));
  const fB = add(palmPt, scale(M.apply(M.mul(R3, M.rotZ(-grip)), down), DIM.finger));

  return { shoulder, elbowPt, wristPt, palmPt, fA, fB };
}

export function solve(setup, pose) {
  const pan = vizDeg(setup, pose, 'head_pan') * D;
  const tilt = vizDeg(setup, pose, 'head_tilt') * D;

  const right = armChain(setup, pose, 'right');
  const left = armChain(setup, pose, 'left');

  const pelvis = [0, DIM.pelvis, 0];
  const chest = [0, DIM.chest, 0];
  const neck = [0, DIM.neckY, 0];
  const Rh = M.mul(M.rotY(pan), M.rotX(-tilt));
  const head = add(neck, scale(M.apply(Rh, [0, 1, 0]), DIM.neckLen + DIM.headRadius * 0.4));
  const eyeL = add(head, M.apply(Rh, [-3, 1.5, DIM.headRadius * 0.95]));
  const eyeR = add(head, M.apply(Rh, [3, 1.5, DIM.headRadius * 0.95]));
  const gaze = add(head, M.apply(Rh, [0, 0, DIM.headRadius + 14]));

  // ---- wheeled base: four wheels on side axles + a platform box ----
  const tx = DIM.wheelTrack;
  const bz = DIM.wheelBase;
  const wr = DIM.wheelRadius;
  const wheels = [
    { id: 'wheel_fl', p: [-tx, wr, bz], label: 'L Wheels' },
    { id: 'wheel_fr', p: [tx, wr, bz], label: 'R Wheels' },
    { id: 'wheel_rl', p: [-tx, wr, -bz], label: '' },
    { id: 'wheel_rr', p: [tx, wr, -bz], label: '' },
  ];

  const hw = DIM.platformHalfW;
  const hd = DIM.platformHalfD;
  const pt = DIM.platformTop;
  const pb = DIM.platformBot;
  const box = (sx, top, sz) => [sx * hw, top ? pt : pb, sz * hd];
  const c = {
    tfl: box(-1, 1, 1), tfr: box(1, 1, 1), trl: box(-1, 1, -1), trr: box(1, 1, -1),
    bfl: box(-1, 0, 1), bfr: box(1, 0, 1), brl: box(-1, 0, -1), brr: box(1, 0, -1),
  };

  const joints = [
    { id: 'head', p: head, r: DIM.headRadius, kind: 'head', label: 'Head' },
    { id: 'neck', p: neck, r: 3.0, kind: 'joint', label: 'Neck' },
    { id: 'right_shoulder', p: right.shoulder, r: 4.0, kind: 'joint', label: 'R Shoulder' },
    { id: 'right_elbow', p: right.elbowPt, r: 3.4, kind: 'joint', label: 'R Elbow' },
    { id: 'right_wrist', p: right.wristPt, r: 2.8, kind: 'joint', label: 'R Wrist' },
    { id: 'left_shoulder', p: left.shoulder, r: 4.0, kind: 'joint', label: 'L Shoulder' },
    { id: 'left_elbow', p: left.elbowPt, r: 3.4, kind: 'joint', label: 'L Elbow' },
    { id: 'left_wrist', p: left.wristPt, r: 2.8, kind: 'joint', label: 'L Wrist' },
    { id: 'pelvis', p: pelvis, r: 3.8, kind: 'joint', label: 'Waist' },
    ...wheels.map((w) => ({ id: w.id, p: w.p, r: wr, kind: 'wheel', label: w.label })),
  ];

  const bones = [
    { a: pelvis, b: chest, w: 7, group: 'torso' },
    { a: chest, b: neck, w: 6, group: 'torso' },
    { a: right.shoulder, b: left.shoulder, w: 5, group: 'torso' },
    { a: neck, b: head, w: 3.2, group: 'head' },

    { a: right.shoulder, b: right.elbowPt, w: 4.4, group: 'right_arm' },
    { a: right.elbowPt, b: right.wristPt, w: 3.6, group: 'right_arm' },
    { a: right.wristPt, b: right.palmPt, w: 3.0, group: 'right_arm' },
    { a: right.palmPt, b: right.fA, w: 1.9, group: 'right_arm' },
    { a: right.palmPt, b: right.fB, w: 1.9, group: 'right_arm' },

    { a: left.shoulder, b: left.elbowPt, w: 4.4, group: 'left_arm' },
    { a: left.elbowPt, b: left.wristPt, w: 3.6, group: 'left_arm' },
    { a: left.wristPt, b: left.palmPt, w: 3.0, group: 'left_arm' },
    { a: left.palmPt, b: left.fA, w: 1.9, group: 'left_arm' },
    { a: left.palmPt, b: left.fB, w: 1.9, group: 'left_arm' },

    // spine down into the platform
    { a: pelvis, b: [0, pt, 0], w: 6, group: 'base' },

    // platform box — top rim, bottom rim, verticals
    { a: c.tfl, b: c.tfr, w: 4, group: 'base' }, { a: c.tfr, b: c.trr, w: 4, group: 'base' },
    { a: c.trr, b: c.trl, w: 4, group: 'base' }, { a: c.trl, b: c.tfl, w: 4, group: 'base' },
    { a: c.bfl, b: c.bfr, w: 3, group: 'base' }, { a: c.bfr, b: c.brr, w: 3, group: 'base' },
    { a: c.brr, b: c.brl, w: 3, group: 'base' }, { a: c.brl, b: c.bfl, w: 3, group: 'base' },
    { a: c.tfl, b: c.bfl, w: 3, group: 'base' }, { a: c.tfr, b: c.bfr, w: 3, group: 'base' },
    { a: c.trl, b: c.brl, w: 3, group: 'base' }, { a: c.trr, b: c.brr, w: 3, group: 'base' },

    // axle stubs from the platform side out to each wheel hub
    { a: [-hw, wr, bz], b: wheels[0].p, w: 2.4, group: 'base' },
    { a: [hw, wr, bz], b: wheels[1].p, w: 2.4, group: 'base' },
    { a: [-hw, wr, -bz], b: wheels[2].p, w: 2.4, group: 'base' },
    { a: [hw, wr, -bz], b: wheels[3].p, w: 2.4, group: 'base' },
  ];

  return { joints, bones, gaze, head, eyes: [eyeL, eyeR], right, left, neck, pelvis };
}
