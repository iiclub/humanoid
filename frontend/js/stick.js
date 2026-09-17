/**
 * Flat stick-figure schematic: straight bones, a circle at every joint, and the
 * pin + live servo angle written next to it. Doubles as the wiring diagram —
 * each joint circle is tinted by the NodeMCU that owns it.
 */

import { solve } from './skeleton.js';
import { travelToAngle } from './jointmath.js';

const NODE_COLORS = {
  right_hand: '#3fb6a8',
  left_hand: '#e08a4c',
  drive: '#8c7cf0',
};

const LABELLED = [
  { pt: 'right_shoulder', joints: ['right_shoulder_x', 'right_shoulder_y'], side: 'right' },
  { pt: 'right_elbow', joints: ['right_elbow'], side: 'right' },
  { pt: 'right_wrist', joints: ['right_wrist_z', 'right_gripper'], side: 'right' },
  { pt: 'left_shoulder', joints: ['left_shoulder_x', 'left_shoulder_y'], side: 'left' },
  { pt: 'left_elbow', joints: ['left_elbow'], side: 'left' },
  { pt: 'left_wrist', joints: ['left_wrist_z', 'left_gripper'], side: 'left' },
  { pt: 'head', joints: ['head_tilt'], side: 'right' },
];

export class StickView {
  constructor(canvas, setup) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.setup = setup;
    this.pose = {};
    this.highlight = null;
    this._resize();
    window.addEventListener('resize', () => { this._resize(); this.draw(); });
  }

  setSetup(setup) { this.setup = setup; }
  setPose(pose) { this.pose = { ...pose }; this.draw(); }
  setHighlight(g) { this.highlight = g; this.draw(); }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(300, rect.width * dpr);
    this.canvas.height = Math.max(240, rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = this.canvas.width / dpr;
    this.h = this.canvas.height / dpr;
  }

  _proj(p) {
    const s = Math.min(this.w / 150, this.h / 110);
    return { x: this.w / 2 + p[0] * s, y: this.h - 18 - p[1] * s };
  }

  _jointById(id) { return this.setup.joints.find((j) => j.id === id); }

  draw() {
    const { ctx } = this;
    if (!this.setup) return;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#0c1018';
    ctx.fillRect(0, 0, this.w, this.h);

    // floor line
    ctx.strokeStyle = 'rgba(140,160,200,0.25)';
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(10, this.h - 18);
    ctx.lineTo(this.w - 10, this.h - 18);
    ctx.stroke();
    ctx.setLineDash([]);

    const sk = solve(this.setup, this.pose);

    // bones
    ctx.lineCap = 'round';
    for (const bone of sk.bones) {
      const A = this._proj(bone.a);
      const B = this._proj(bone.b);
      const dim = this.highlight && this.highlight !== bone.group;
      ctx.strokeStyle = dim ? 'rgba(150,165,195,0.22)' : 'rgba(205,220,255,0.85)';
      ctx.lineWidth = dim ? 1.6 : 2.6;
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.lineTo(B.x, B.y);
      ctx.stroke();
    }

    // joint circles
    const byId = new Map(sk.joints.map((j) => [j.id, j]));
    for (const j of sk.joints) {
      const P = this._proj(j.p);
      const owner = j.id.startsWith('right_') ? 'right_hand'
        : j.id.startsWith('left_') || j.id === 'head' || j.id === 'neck' ? 'left_hand'
          : j.kind === 'wheel' ? 'drive' : null;
      const color = NODE_COLORS[owner] || '#9aa6c0';
      const r = j.kind === 'head' ? 13 : j.kind === 'wheel' ? 11 : 7;

      ctx.beginPath();
      ctx.arc(P.x, P.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#0c1018';
      ctx.fill();
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = color;
      ctx.stroke();

      if (j.kind === 'head') {
        ctx.fillStyle = '#7ef7de';
        ctx.beginPath(); ctx.arc(P.x - 4, P.y - 2, 1.8, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(P.x + 4, P.y - 2, 1.8, 0, Math.PI * 2); ctx.fill();
      }
    }

    // labels: pin + live servo angle
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const spec of LABELLED) {
      const pt = byId.get(spec.pt);
      if (!pt) continue;
      const P = this._proj(pt.p);
      const lines = spec.joints
        .map((id) => this._jointById(id))
        .filter(Boolean)
        .map((j) => `${j.pin} ${String(travelToAngle(j, this.pose[j.id] ?? 0)).padStart(3)}°`);

      const dir = spec.side === 'right' ? 1 : -1;
      const x = P.x + dir * 16;
      let y = P.y - ((lines.length - 1) * 12) / 2;
      ctx.textAlign = dir > 0 ? 'left' : 'right';
      for (const line of lines) {
        ctx.fillStyle = 'rgba(180,196,230,0.9)';
        ctx.fillText(line, x, y);
        y += 12;
      }
    }

    // legend
    ctx.textAlign = 'left';
    let lx = 12;
    for (const [node, color] of Object.entries(NODE_COLORS)) {
      const label = this.setup.nodes?.[node]?.label || node;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(lx + 4, 14, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(180,196,230,0.8)';
      ctx.fillText(label, lx + 12, 14);
      lx += ctx.measureText(label).width + 30;
    }
  }
}
