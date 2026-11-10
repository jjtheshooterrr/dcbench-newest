// Plan-view canvas plot with exaggerated residual vectors.
import { Vec3, norm, sub, dot } from "../core/geom";

export interface PlotSpec {
  pts: Vec3[]; names: string[];
  residuals?: (Vec3 | number)[];      // vector or scalar (plane offset / radial dev)
  circle?: { center: Vec3; r: number; u: Vec3; v: Vec3 };
  after?: Vec3[];                      // transformed positions (before → after arrows)
  tol: number; unitFactor: number;
}

export function drawPlot(cv: HTMLCanvasElement, p: PlotSpec, hintEl?: HTMLElement) {
  const ctx = cv.getContext("2d")!; const W = cv.width, H = cv.height;
  const cs = getComputedStyle(document.documentElement), col = (k: string) => cs.getPropertyValue(k).trim();
  ctx.clearRect(0, 0, W, H);
  if (!p.pts.length) return;
  const pts = p.circle ? p.pts.map(q => [dot(sub(q, p.circle!.center), p.circle!.u), dot(sub(q, p.circle!.center), p.circle!.v)]) : p.pts.map(q => [q[0], q[1]]);
  const all = p.after ? pts.concat(p.after.map(q => [q[0], q[1]])) : pts.slice();
  const xs = all.map(q => q[0]), ys = all.map(q => q[1]);
  if (p.circle) { xs.push(-p.circle.r, p.circle.r); ys.push(-p.circle.r, p.circle.r); }
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const span = Math.max(maxx - minx, maxy - miny, 1e-9), pad = 60, sc = (Math.min(W, H) - 2 * pad) / span;
  const ox = W / 2 - sc * (minx + maxx) / 2, oy = H / 2 + sc * (miny + maxy) / 2;
  const X = (v: number) => ox + v * sc, Y = (v: number) => oy - v * sc;
  ctx.font = "12px " + col("--mono"); ctx.lineWidth = 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / 4)));
  ctx.strokeStyle = col("--line"); ctx.fillStyle = col("--muted");
  for (let gx = Math.ceil(minx / step) * step; gx <= maxx; gx += step) { ctx.beginPath(); ctx.moveTo(X(gx), 0); ctx.lineTo(X(gx), H); ctx.stroke(); ctx.fillText((gx * p.unitFactor).toFixed(0), X(gx) + 3, H - 6); }
  for (let gy = Math.ceil(miny / step) * step; gy <= maxy; gy += step) { ctx.beginPath(); ctx.moveTo(0, Y(gy)); ctx.lineTo(W, Y(gy)); ctx.stroke(); ctx.fillText((gy * p.unitFactor).toFixed(0), 4, Y(gy) - 3); }
  const mags = p.residuals?.map(r => (Array.isArray(r) ? norm(r) : Math.abs(r))) ?? [];
  const exag = mags.length ? Math.max(1, 0.08 * span / Math.max(...mags, 1e-12)) : 1;
  if (p.circle) {
    ctx.strokeStyle = col("--accent"); ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.arc(X(0), Y(0), p.circle.r * sc, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(X(0) - 8, Y(0)); ctx.lineTo(X(0) + 8, Y(0)); ctx.moveTo(X(0), Y(0) - 8); ctx.lineTo(X(0), Y(0) + 8); ctx.stroke();
  }
  if (hintEl) hintEl.textContent = p.circle ? `in-plane view · radial deviation ×${exag.toFixed(0)}` : p.after ? "plan view · before → after" : p.residuals ? `plan view · residuals ×${exag.toFixed(0)}` : "plan view";
  const tolM = p.tol / p.unitFactor;
  pts.forEach((q, i) => {
    let tip: number[] | undefined;
    const r = p.residuals?.[i];
    if (Array.isArray(r)) tip = [q[0] + r[0] * exag, q[1] + r[1] * exag];
    else if (p.circle && typeof r === "number") { const a = Math.atan2(q[1], q[0]); tip = [q[0] + Math.cos(a) * r * exag, q[1] + Math.sin(a) * r * exag]; }
    else if (p.after) tip = [p.after[i][0], p.after[i][1]];
    const m = mags[i] ?? 0;
    const c = p.after ? col("--accent") : m > tolM ? col("--bad") : m > tolM * 0.66 ? col("--warn") : col("--ok");
    if (tip) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(q[0]), Y(q[1])); ctx.lineTo(X(tip[0]), Y(tip[1])); ctx.stroke(); ctx.fillStyle = c; ctx.beginPath(); ctx.arc(X(tip[0]), Y(tip[1]), 3, 0, 7); ctx.fill(); }
    else if (typeof r === "number") { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(q[0]), Y(q[1]), 4 + Math.abs(r) * exag * sc * 0.5, 0, 7); ctx.stroke(); }
    ctx.fillStyle = col("--fg"); ctx.beginPath(); ctx.arc(X(q[0]), Y(q[1]), 4, 0, 7); ctx.fill();
    ctx.fillText(p.names[i], X(q[0]) + 7, Y(q[1]) - 7);
  });
}
