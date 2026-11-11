// Orbitable 3D view on a 2D canvas (orthographic, Z up). No WebGL, so it runs on any field tablet.
import { Vec3, sub, dot, cross, DEG } from "../core/geom";

export interface Scene3D {
  points: { name: string; p: Vec3; selected?: boolean; derived?: boolean }[];
  polylines: { pts: Vec3[]; closed?: boolean; dashed?: boolean }[];
}

export class View3D {
  az = -35; el = 25; zoom = 1; panX = 0; panY = 0; labels = true;
  onHover?: (text: string) => void;
  private c: Vec3 = [0, 0, 0]; private radius = 1;
  private screenPts: { x: number; y: number; i: number }[] = [];

  constructor(private cv: HTMLCanvasElement, public scene: Scene3D, private fmt: (metres: number) => string, private unitLabel: string, private unitFactor: number) {
    this.fit();
    let drag: { x: number; y: number; pan: boolean } | null = null;
    cv.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button !== 0 }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener("pointerup", e => { drag = null; cv.releasePointerCapture(e.pointerId); });
    cv.addEventListener("contextmenu", e => e.preventDefault());
    cv.addEventListener("pointermove", e => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
        if (drag.pan) { this.panX += dx; this.panY += dy; } else { this.az -= dx * 0.4; this.el = Math.max(-90, Math.min(90, this.el + dy * 0.4)); }
        this.draw(); return;
      }
      const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      let best = -1, bd = 12 * 12;
      for (const s of this.screenPts) { const d = (s.x - mx) ** 2 + (s.y - my) ** 2; if (d < bd) { bd = d; best = s.i; } }
      const p = best >= 0 ? this.scene.points[best] : null;
      this.onHover?.(p ? `${p.name}   E ${this.fmt(p.p[0])}   N ${this.fmt(p.p[1])}   H ${this.fmt(p.p[2])} ${this.unitLabel}` : "");
    });
    cv.addEventListener("wheel", e => { e.preventDefault(); this.zoom = Math.max(0.05, Math.min(500, this.zoom * Math.exp(-e.deltaY * 0.0015))); this.draw(); }, { passive: false });
    cv.addEventListener("dblclick", () => { this.fit(); this.draw(); });
    new ResizeObserver(() => this.draw()).observe(cv);
  }

  fit() {
    const all = [...this.scene.points.map(p => p.p), ...this.scene.polylines.flatMap(l => l.pts)];
    if (!all.length) { this.c = [0, 0, 0]; this.radius = 1; return; }
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of all) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    this.c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    this.radius = Math.max(1e-6, ...all.map(p => Math.hypot(p[0] - this.c[0], p[1] - this.c[1], p[2] - this.c[2])));
    this.zoom = 1; this.panX = 0; this.panY = 0;
  }
  /** Zoom to a subset of points (e.g. the current selection). */
  focus(pts: Vec3[]) {
    if (!pts.length) return;
    const c: Vec3 = [0, 0, 0]; for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k] / pts.length;
    this.c = c; this.radius = Math.max(0.05, ...pts.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])) ) * 1.3; this.zoom = 1; this.panX = 0; this.panY = 0; this.draw();
  }
  preset(v: "iso" | "plan" | "north" | "east") {
    [this.az, this.el] = v === "plan" ? [0, 90] : v === "north" ? [0, 0] : v === "east" ? [90, 0] : [-35, 25];
    this.draw();
  }

  draw() {
    const cv = this.cv, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext("2d")!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const cs = getComputedStyle(document.documentElement), col = (k: string) => cs.getPropertyValue(k).trim();
    const a = this.az * DEG, e = this.el * DEG;
    const fwd: Vec3 = [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), -Math.sin(e)], right: Vec3 = [Math.cos(a), -Math.sin(a), 0], up = cross(right, fwd);
    const ppm = this.zoom * (Math.min(W, H) / 2 - 40) / this.radius;
    const P = (p: Vec3) => { const d = sub(p, this.c); return { x: W / 2 + this.panX + dot(d, right) * ppm, y: H / 2 + this.panY - dot(d, up) * ppm, z: dot(d, fwd) }; };

    ctx.lineWidth = 1.5; ctx.strokeStyle = col("--accent");
    for (const l of this.scene.polylines) {
      if (l.pts.length < 2) continue;
      ctx.setLineDash(l.dashed ? [6, 4] : []); ctx.beginPath();
      l.pts.forEach((p, i) => { const s = P(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      if (l.closed) ctx.closePath(); ctx.stroke();
    }
    ctx.setLineDash([]);

    const proj = this.scene.points.map((p, i) => ({ ...P(p.p), i })).sort((m, n) => n.z - m.z);
    this.screenPts = proj;
    ctx.font = "12px " + col("--mono");
    for (const s of proj) {
      const pt = this.scene.points[s.i];
      ctx.fillStyle = pt.selected ? col("--accent") : pt.derived ? col("--ok") : col("--fg");
      ctx.beginPath(); ctx.arc(s.x, s.y, pt.selected ? 4.5 : 3.5, 0, 7); ctx.fill();
      if (this.labels) { ctx.fillStyle = col("--muted"); ctx.fillText(pt.name, s.x + 7, s.y - 6); }
    }

    // axis triad
    const o = { x: 46, y: H - 46 };
    for (const [v, name, c] of [[[1, 0, 0], "E", "--bad"], [[0, 1, 0], "N", "--ok"], [[0, 0, 1], "H", "--accent"]] as [Vec3, string, string][]) {
      const x = o.x + dot(v, right) * 30, y = o.y - dot(v, up) * 30;
      ctx.strokeStyle = col(c); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = col("--fg"); ctx.fillText(name, x + (x >= o.x ? 4 : -12), y + (y > o.y ? 12 : -4));
    }
    // scale bar
    const targetUnits = (130 / ppm) * this.unitFactor, mag = Math.pow(10, Math.floor(Math.log10(targetUnits))), nice = [5, 2, 1].map(k => k * mag).find(v => v <= targetUnits) ?? mag;
    const len = (nice / this.unitFactor) * ppm, bx = W - 24 - len, by = H - 28;
    ctx.strokeStyle = col("--fg"); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(bx, by - 5); ctx.lineTo(bx, by); ctx.lineTo(bx + len, by); ctx.lineTo(bx + len, by - 5); ctx.stroke();
    ctx.fillStyle = col("--fg"); ctx.textAlign = "center"; ctx.fillText(`${+nice.toPrecision(3)} ${this.unitLabel}`, bx + len / 2, by + 15); ctx.textAlign = "left";
  }
}
