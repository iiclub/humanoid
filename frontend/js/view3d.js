/**
 * Dependency-free 3D humanoid viewer.
 *
 * Software perspective projection onto a 2D canvas with painter's-algorithm
 * sorting. No three.js, no CDN — the whole UI has to work on a robot LAN with
 * no internet, from a laptop or a tablet.
 */

import { M, solve, DIM } from './skeleton.js';

const GROUP_COLORS = {
  torso: '#5b6b8c',
  head: '#7c8cb5',
  right_arm: '#3fb6a8',
  left_arm: '#e08a4c',
  base: '#57607a',
};

export class View3D {
  constructor(canvas, setup) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.setup = setup;

    this.pose = {};
    this.display = {};      // eased copy, so the robot glides instead of snapping
    this.highlight = null;
    this.spin = true;
    this.driveState = { left: 0, right: 0 };
    this.wheelPhase = 0;

    this.yaw = 0.5;
    this.pitch = 0.18;
    this.distance = 210;
    this.focal = 620;
    this.target = [0, 34, 0];

    this._bindPointer();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    requestAnimationFrame(() => this._frame());
  }

  setSetup(setup) { this.setup = setup; }

  setPose(pose) {
    this.pose = { ...pose };
    for (const k of Object.keys(this.pose)) {
      if (this.display[k] == null) this.display[k] = this.pose[k];
    }
  }

  setDrive(drive) { this.driveState = drive || { left: 0, right: 0 }; }
  setHighlight(group) { this.highlight = group; }
  toggleSpin() { this.spin = !this.spin; return this.spin; }
  resetView() { this.yaw = 0.5; this.pitch = 0.18; this.distance = 210; }

  // ------------------------------------------------------------- interaction

  _bindPointer() {
    const c = this.canvas;
    const pointers = new Map();
    let lastPinch = 0;

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.spin = false;
    });

    c.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1) {
        this.yaw -= dx * 0.008;
        this.pitch = Math.max(-0.9, Math.min(1.1, this.pitch + dy * 0.006));
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (lastPinch) this.distance = Math.max(90, Math.min(420, this.distance - (d - lastPinch)));
        lastPinch = d;
      }
    });

    const release = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) lastPinch = 0; };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance = Math.max(90, Math.min(420, this.distance + e.deltaY * 0.25));
    }, { passive: false });
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(320, rect.width * dpr);
    this.canvas.height = Math.max(260, rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = this.canvas.width / dpr;
    this.h = this.canvas.height / dpr;
  }

  // -------------------------------------------------------------- projection

  _project(p) {
    let v = [p[0] - this.target[0], p[1] - this.target[1], p[2] - this.target[2]];
    v = M.apply(M.rotY(-this.yaw), v);
    v = M.apply(M.rotX(-this.pitch), v);
    const z = v[2] + this.distance;
    const depth = Math.max(20, z);
    const s = this.focal / depth;
    return { x: this.w / 2 + v[0] * s, y: this.h / 2 - v[1] * s + this.h * 0.08, z: depth, s: s / 6 };
  }

  // ------------------------------------------------------------------- frame

  _frame() {
    // ease the displayed pose toward the commanded one
    for (const [k, v] of Object.entries(this.pose)) {
      const cur = this.display[k] ?? v;
      this.display[k] = cur + (v - cur) * 0.18;
    }
    if (this.spin) this.yaw += 0.004;

    const speed = (this.driveState.left + this.driveState.right) / 2;
    this.wheelPhase += speed * 0.00012;

    this._draw();
    requestAnimationFrame(() => this._frame());
  }

  _draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);

    // backdrop
    const bg = ctx.createRadialGradient(this.w / 2, this.h * 0.35, 20, this.w / 2, this.h * 0.5, this.h);
    bg.addColorStop(0, '#141a26');
    bg.addColorStop(1, '#080a11');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.h);

    this._drawFloor();

    const sk = solve(this.setup, this.display);
    const items = [];

    // ground shadow
    const sh = this._project([0, 0.2, 0]);
    items.push({
      z: 1e6,
      draw: () => {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(sh.x, sh.y, 34 * sh.s * 6 * 0.5, 12 * sh.s * 6 * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      },
    });

    for (const bone of sk.bones) {
      const A = this._project(bone.a);
      const B = this._project(bone.b);
      const z = (A.z + B.z) / 2;
      const dim = this.highlight && this.highlight !== bone.group;
      items.push({
        z,
        draw: () => {
          const base = GROUP_COLORS[bone.group] || '#6b7690';
          ctx.save();
          ctx.globalAlpha = dim ? 0.32 : 1;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          const grad = ctx.createLinearGradient(A.x, A.y, B.x, B.y);
          grad.addColorStop(0, this._shade(base, 1.25));
          grad.addColorStop(1, this._shade(base, 0.75));
          ctx.strokeStyle = grad;
          ctx.lineWidth = Math.max(1.5, bone.w * ((A.s + B.s) / 2) * 6);
          ctx.beginPath();
          ctx.moveTo(A.x, A.y);
          ctx.lineTo(B.x, B.y);
          ctx.stroke();
          ctx.restore();
        },
      });
    }

    for (const j of sk.joints) {
      const P = this._project(j.p);
      const group = j.id.startsWith('right_') ? 'right_arm'
        : j.id.startsWith('left_') ? 'left_arm'
          : j.kind === 'wheel' ? 'base'
            : j.kind === 'head' ? 'head' : 'torso';
      const dim = this.highlight && this.highlight !== group;
      items.push({
        z: P.z,
        draw: () => {
          // A real wheel: a short cylinder whose axle runs along X (left/right).
          // Its circular faces live in the Y-Z plane, so it reads edge-on from
          // the front and opens to a full circle from the side as you orbit —
          // instead of always facing the camera like a flat disc.
          if (j.kind === 'wheel') { this._drawWheel(j, dim); return; }

          const r = Math.max(2, j.r * P.s * 6);
          ctx.save();
          ctx.globalAlpha = dim ? 0.35 : 1;

          if (j.kind === 'head') {
            const g = ctx.createRadialGradient(P.x - r * 0.3, P.y - r * 0.4, r * 0.2, P.x, P.y, r);
            g.addColorStop(0, '#aab8dd');
            g.addColorStop(1, '#495571');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(P.x, P.y, r, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = '#0d1119';
            ctx.strokeStyle = dim ? '#7d879c' : '#d7e2ff';
            ctx.lineWidth = Math.max(1.4, 1.6 * P.s * 6);
            ctx.beginPath();
            ctx.arc(P.x, P.y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
          ctx.restore();
        },
      });
    }

    // eyes + gaze ray, so head pan/tilt reads instantly
    for (const eye of sk.eyes) {
      const E = this._project(eye);
      items.push({
        z: E.z - 1,
        draw: () => {
          ctx.save();
          ctx.fillStyle = '#7ef7de';
          ctx.shadowColor = '#7ef7de';
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.arc(E.x, E.y, Math.max(1.5, 1.6 * E.s * 6), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        },
      });
    }
    const H = this._project(sk.head);
    const G = this._project(sk.gaze);
    items.push({
      z: G.z,
      draw: () => {
        ctx.save();
        ctx.strokeStyle = 'rgba(126,247,222,0.35)';
        ctx.setLineDash([5, 6]);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(H.x, H.y);
        ctx.lineTo(G.x, G.y);
        ctx.stroke();
        ctx.restore();
      },
    });

    items.sort((a, b) => b.z - a.z);
    for (const it of items) it.draw();

    this._drawHud();
  }

  _drawFloor() {
    const { ctx } = this;
    const half = 75;
    const step = 15;
    ctx.save();
    ctx.strokeStyle = 'rgba(120,140,190,0.13)';
    ctx.lineWidth = 1;
    for (let i = -half; i <= half; i += step) {
      const a = this._project([i, 0, -half]);
      const b = this._project([i, 0, half]);
      const c = this._project([-half, 0, i]);
      const d = this._project([half, 0, i]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Draw one wheel as a short cylinder (tyre) with a hub and turning spokes.
   * The axle is along X, so the two round faces sit in the Y-Z plane at
   * x ± wheelWidth/2. Everything is projected in 3D, so the orientation is
   * always correct: edge-on from the front, a full circle from the side.
   */
  _drawWheel(j, dim) {
    const { ctx } = this;
    const N = 20;
    const r = j.r;
    const halfW = DIM.wheelWidth / 2;

    const ring = (dx) => {
      const pts = [];
      for (let k = 0; k < N; k++) {
        const a = (k / N) * Math.PI * 2;
        pts.push(this._project([j.p[0] + dx, j.p[1] + r * Math.cos(a), j.p[2] + r * Math.sin(a)]));
      }
      return pts;
    };
    const poly = (pts) => {
      ctx.beginPath();
      pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
    };

    const outer = ring(halfW);
    const inner = ring(-halfW);
    const cOut = this._project([j.p[0] + halfW, j.p[1], j.p[2]]);
    const cIn = this._project([j.p[0] - halfW, j.p[1], j.p[2]]);
    const nearIsOuter = cOut.z < cIn.z;
    const near = nearIsOuter ? outer : inner;
    const nearC = nearIsOuter ? cOut : cIn;
    const nearX = j.p[0] + (nearIsOuter ? halfW : -halfW);

    ctx.save();
    ctx.globalAlpha = dim ? 0.4 : 1;
    ctx.lineJoin = 'round';

    // tyre tread — quads bridging the two rims
    ctx.fillStyle = '#0d111a';
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      ctx.beginPath();
      ctx.moveTo(outer[k].x, outer[k].y);
      ctx.lineTo(outer[k2].x, outer[k2].y);
      ctx.lineTo(inner[k2].x, inner[k2].y);
      ctx.lineTo(inner[k].x, inner[k].y);
      ctx.closePath();
      ctx.fill();
    }

    // near face (the rim you can see) with a subtle radial shade
    const rimR = Math.max(3, r * nearC.s * 6);
    const g = ctx.createRadialGradient(nearC.x - rimR * 0.3, nearC.y - rimR * 0.3, rimR * 0.15, nearC.x, nearC.y, rimR);
    g.addColorStop(0, '#2b344a');
    g.addColorStop(1, '#141a26');
    ctx.fillStyle = g;
    poly(near);
    ctx.fill();
    ctx.strokeStyle = dim ? '#5b657d' : '#9aa6c0';
    ctx.lineWidth = Math.max(1.4, 1.6 * nearC.s * 6);
    ctx.stroke();

    // spokes that turn while driving
    ctx.strokeStyle = dim ? '#4a5468' : '#6b7690';
    ctx.lineWidth = Math.max(1, 1.4 * nearC.s * 6);
    for (let i = 0; i < 3; i++) {
      const a = this.wheelPhase + (i * Math.PI) / 3;
      const p1 = this._project([nearX, j.p[1] + r * 0.82 * Math.cos(a), j.p[2] + r * 0.82 * Math.sin(a)]);
      const p2 = this._project([nearX, j.p[1] - r * 0.82 * Math.cos(a), j.p[2] - r * 0.82 * Math.sin(a)]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    // hub
    ctx.fillStyle = dim ? '#3a4458' : '#c2ccdf';
    ctx.beginPath();
    ctx.arc(nearC.x, nearC.y, Math.max(1.6, r * 0.22 * nearC.s * 6), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _drawHud() {
    const { ctx } = this;
    ctx.save();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(190,205,235,0.55)';
    ctx.fillText('drag to orbit · pinch / wheel to zoom', 12, this.h - 12);
    const { left, right } = this.driveState;
    if (left || right) {
      ctx.fillStyle = '#7ef7de';
      ctx.fillText(`drive  L ${left}  R ${right}`, 12, this.h - 28);
    }
    ctx.restore();
  }

  _shade(hex, factor) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.round(((n >> 16) & 255) * factor));
    const g = Math.min(255, Math.round(((n >> 8) & 255) * factor));
    const b = Math.min(255, Math.round((n & 255) * factor));
    return `rgb(${r},${g},${b})`;
  }
}

export { DIM };
