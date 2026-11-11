// Least-squares fitting routines used in dimensional control.
import { Vec3, Mat3, add, sub, scl, dot, cross, unit, norm, matvec, centroid, jacobi, quatToMat, solve3, solve2, solveN, levenbergMarquardt, rms, rotFromTo, eulerZYX, DEG } from "./geom";

export interface BestFitResult {
  R: Mat3; t: Vec3; s: number;
  residuals: Vec3[]; magnitudes: number[]; rms: number; max: number;
  rotXYZ: Vec3; // degrees
  centroidA: Vec3; centroidB: Vec3;
}

/**
 * Horn's closed-form absolute orientation. Finds s, R, t minimising
 * Σ w_i |B_i − (s·R·A_i + t)|². With scale=false this is a 6-parameter
 * rigid fit (3D) or, with z=0 on all points, a 3-parameter 2D fit.
 */
export function bestFit(A: Vec3[], B: Vec3[], opts: { scale?: boolean; weights?: number[] } = {}): BestFitResult {
  if (A.length !== B.length) throw new Error("Point lists differ in length");
  if (A.length < 3) throw new Error("Need at least 3 common points");
  const n = A.length, w = opts.weights ?? A.map(() => 1), W = w.reduce((a, b) => a + b, 0);
  const ca = scl(A.reduce((s, p, i) => add(s, scl(p, w[i])), [0, 0, 0]), 1 / W);
  const cb = scl(B.reduce((s, p, i) => add(s, scl(p, w[i])), [0, 0, 0]), 1 / W);
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let sa = 0;
  for (let i = 0; i < n; i++) {
    const a = sub(A[i], ca), b = sub(B[i], cb);
    sa += w[i] * dot(a, a);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r][c] += w[i] * a[r] * b[c];
  }
  const [Sxx, Sxy, Sxz] = M[0], [Syx, Syy, Syz] = M[1], [Szx, Szy, Szz] = M[2];
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const e = jacobi(N);
  let k = 0; e.vals.forEach((v, i) => { if (v > e.vals[k]) k = i; });
  const R = quatToMat(e.vecs.map(r => r[k]));
  let s = 1;
  if (opts.scale) { let num = 0; for (let i = 0; i < n; i++) num += w[i] * dot(sub(B[i], cb), matvec(R, sub(A[i], ca))); s = num / sa; }
  const t = sub(cb, scl(matvec(R, ca), s));
  const residuals = A.map((p, i) => sub(B[i], add(scl(matvec(R, p), s), t)));
  const magnitudes = residuals.map(norm);
  return { R, t, s, residuals, magnitudes, rms: rms(magnitudes), max: Math.max(...magnitudes), rotXYZ: eulerZYX(R), centroidA: ca, centroidB: cb };
}

export const applyFit = (f: { R: Mat3; t: Vec3; s: number }, p: Vec3): Vec3 => add(scl(matvec(f.R, p), f.s), f.t);

export interface PlaneResult { c: Vec3; n: Vec3; d: number; residuals: number[]; rms: number; pitchDeg: number; rollDeg: number; tiltDeg: number; }

/** Orthogonal least-squares plane: centroid + smallest covariance eigenvector. Normal oriented +Z. */
export function planeFit(P: Vec3[]): PlaneResult {
  if (P.length < 3) throw new Error("Need at least 3 points for a plane");
  const c = centroid(P), C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of P) { const d = sub(p, c); for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) C[r][k] += d[r] * d[k]; }
  const e = jacobi(C);
  let k = 0; e.vals.forEach((v, i) => { if (v < e.vals[k]) k = i; });
  let n = unit(e.vecs.map(r => r[k]) as Vec3);
  if (n[2] < 0) n = scl(n, -1);
  const residuals = P.map(p => dot(sub(p, c), n));
  return {
    c, n, d: -dot(n, c), residuals, rms: rms(residuals),
    pitchDeg: Math.atan2(n[0], n[2]) / DEG, rollDeg: Math.atan2(n[1], n[2]) / DEG,
    tiltDeg: Math.acos(Math.min(1, n[2])) / DEG,
  };
}

export interface Circle2D { cx: number; cy: number; r: number; residuals: number[]; }

/** 2D circle: Kåsa algebraic start then Gauss-Newton geometric refinement. */
export function circleFit2D(pts: [number, number][], fixedR?: number): Circle2D {
  if (pts.length < 3) throw new Error("Need at least 3 points for a circle");
  const n = pts.length; let cx: number, cy: number, r: number;
  if (fixedR) { cx = pts.reduce((s, p) => s + p[0], 0) / n; cy = pts.reduce((s, p) => s + p[1], 0) / n; r = fixedR; }
  else {
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
    for (const [x, y] of pts) { const row = [x, y, 1], z = x * x + y * y; for (let i = 0; i < 3; i++) { v[i] += row[i] * z; for (let j = 0; j < 3; j++) S[i][j] += row[i] * row[j]; } }
    const sol = solve3(S, v); cx = sol[0] / 2; cy = sol[1] / 2; r = Math.sqrt(Math.max(0, sol[2] + cx * cx + cy * cy));
  }
  for (let it = 0; it < 60; it++) {
    const np = fixedR ? 2 : 3;
    const JtJ = Array.from({ length: np }, () => Array(np).fill(0)), Jtr = Array(np).fill(0);
    for (const [x, y] of pts) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1e-12, res = d - r, J = [-dx / d, -dy / d, -1].slice(0, np);
      for (let i = 0; i < np; i++) { Jtr[i] += J[i] * res; for (let j = 0; j < np; j++) JtJ[i][j] += J[i] * J[j]; }
    }
    const dlt = np === 3 ? solve3(JtJ, Jtr.map(v => -v)) : solve2(JtJ, Jtr.map(v => -v));
    cx += dlt[0]; cy += dlt[1]; if (!fixedR) r += dlt[2];
    if (Math.hypot(...dlt) < 1e-10) break;
  }
  return { cx, cy, r, residuals: pts.map(([x, y]) => Math.hypot(x - cx, y - cy) - r) };
}

export interface Circle3D { center: Vec3; r: number; n: Vec3; u: Vec3; v: Vec3; residuals: number[]; planeResiduals: number[]; angles: number[]; rms: number; }

/** 3D circle: fit plane, project to plane axes, 2D fit, back-project. */
export function circleFit3D(P: Vec3[], fixedR?: number): Circle3D {
  const pl = planeFit(P);
  const u = unit(cross(pl.n, Math.abs(pl.n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(pl.n, u);
  const p2 = P.map(p => { const d = sub(p, pl.c); return [dot(d, u), dot(d, v)] as [number, number]; });
  const c2 = circleFit2D(p2, fixedR);
  const center = add(pl.c, add(scl(u, c2.cx), scl(v, c2.cy)));
  const angles = p2.map(([x, y]) => ((Math.atan2(y - c2.cy, x - c2.cx) / DEG) + 360) % 360);
  return { center, r: c2.r, n: pl.n, u, v, residuals: c2.residuals, planeResiduals: pl.residuals, angles, rms: rms(c2.residuals) };
}

export interface FlangeResult {
  circle: Circle3D; pcd: number; pcdError: number; faceAngleDeg: number; pitchDeg: number; rollDeg: number;
  nominalSpacingDeg: number; maxSpacingErrorDeg: number; holeAngles: number[]; face?: PlaneResult; faceToHolesGapMm?: number;
  /** Design axis used (resolved when "auto"), and the face normal oriented along +axis. */
  axis: "x" | "y" | "z"; normal: Vec3;
  /** For a face on a horizontal run (axis x or y): lean up/down, and skew in plan from the design axis. Zero for axis z (use pitch/roll). */
  tiltDeg: number; skewDeg: number;
  /** Bolt-hole clock angles from the reference line, anticlockwise seen with the normal pointing at the viewer. */
  clockDeg: number[]; clockReference: "up" | "north";
  /** Pattern rotation from "a hole on the reference line", in (−spacing/2, spacing/2]. */
  onCentreRotationDeg: number;
  /** Pattern rotation from the two-holed position (holes straddling the reference line). 0 = correctly two-holed. */
  twoHoleErrorDeg: number;
  /** The same error as an arc length at the PCD (metres). */
  twoHoleErrorArc: number;
}

/**
 * Flange: bolt holes → PCD circle + normal; optional separate face points →
 * face plane (flatness, gap between hole plane and face plane). Two-holing is
 * checked against plant up (flange on a horizontal run) or north (flange
 * facing up or down).
 */
export function flangeFit(holes: Vec3[], opts: { nHoles: number; nominalPCD: number; axis: "x" | "y" | "z" | "auto"; facePoints?: Vec3[] }): FlangeResult {
  const circle = circleFit3D(holes);
  const n0 = circle.n;
  const axis = opts.axis === "auto" ? (["x", "y", "z"] as const)[[0, 1, 2].reduce((b, i) => (Math.abs(n0[i]) > Math.abs(n0[b]) ? i : b), 0)] : opts.axis;
  const axisV: Vec3 = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
  const normal = dot(n0, axisV) >= 0 ? n0 : scl(n0, -1);
  const faceAngleDeg = Math.acos(Math.min(1, Math.abs(dot(circle.n, axisV)))) / DEG;
  const nominal = 360 / opts.nHoles;
  const sorted = [...circle.angles].sort((a, b) => a - b);
  const gaps = sorted.map((a, i) => ((sorted[(i + 1) % sorted.length] - a) + 360) % 360);
  // clock angles from the projected reference direction
  const ref: Vec3 = axis === "z" ? [0, 1, 0] : [0, 0, 1];
  const refP = unit(sub(ref, scl(normal, dot(ref, normal)))), side = cross(normal, refP);
  const clockDeg = holes.map(h => { const d = sub(h, circle.center); return ((Math.atan2(dot(d, side), dot(d, refP)) / DEG) + 360) % 360; });
  // circular mean of the angles folded onto one hole pitch
  let sx = 0, sy = 0;
  for (const a of clockDeg) { sx += Math.cos(a * opts.nHoles * DEG); sy += Math.sin(a * opts.nHoles * DEG); }
  const wrap = (a: number) => { let v = ((a + nominal / 2) % nominal + nominal) % nominal - nominal / 2; if (v <= -nominal / 2 + 1e-12) v += nominal; return v; };
  const onCentre = wrap(Math.atan2(sy, sx) / DEG / opts.nHoles);
  const twoHole = wrap(onCentre - nominal / 2);
  const res: FlangeResult = {
    circle, pcd: 2 * circle.r, pcdError: 2 * circle.r - opts.nominalPCD, faceAngleDeg,
    pitchDeg: Math.atan2(circle.n[0], circle.n[2]) / DEG, rollDeg: Math.atan2(circle.n[1], circle.n[2]) / DEG,
    nominalSpacingDeg: nominal, maxSpacingErrorDeg: Math.max(...gaps.map(g => Math.abs(g - nominal))), holeAngles: circle.angles,
    axis, normal,
    tiltDeg: axis === "z" ? 0 : Math.asin(Math.max(-1, Math.min(1, normal[2]))) / DEG,
    skewDeg: axis === "x" ? Math.atan2(normal[1], normal[0]) / DEG : axis === "y" ? Math.atan2(-normal[0], normal[1]) / DEG : 0,
    clockDeg, clockReference: axis === "z" ? "north" : "up",
    onCentreRotationDeg: onCentre, twoHoleErrorDeg: twoHole, twoHoleErrorArc: twoHole * DEG * circle.r,
  };
  if (opts.facePoints && opts.facePoints.length >= 3) {
    res.face = planeFit(opts.facePoints);
    res.faceToHolesGapMm = dot(sub(circle.center, res.face.c), res.face.n);
  }
  return res;
}

/** Corner fit: three planes → their intersection point (e.g. a pad or beam corner). */
export function cornerFit(p1: Vec3[], p2: Vec3[], p3: Vec3[]): { point: Vec3; planes: PlaneResult[] } {
  const planes = [planeFit(p1), planeFit(p2), planeFit(p3)];
  const A = planes.map(p => [...p.n]), b = planes.map(p => -p.d);
  const point = solve3(A, b) as Vec3;
  return { point, planes };
}

/** Line fit (axis of a pipe from points on its centreline, or along a straight edge). */
export function lineFit(P: Vec3[]): { c: Vec3; dir: Vec3; residuals: number[]; rms: number } {
  if (P.length < 2) throw new Error("Need at least 2 points");
  const c = centroid(P), C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of P) { const d = sub(p, c); for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) C[r][k] += d[r] * d[k]; }
  const e = jacobi(C);
  let k = 0; e.vals.forEach((v, i) => { if (v > e.vals[k]) k = i; });
  const dir = unit(e.vecs.map(r => r[k]) as Vec3);
  const residuals = P.map(p => { const d = sub(p, c); return norm(sub(d, scl(dir, dot(d, dir)))); });
  return { c, dir, residuals, rms: rms(residuals) };
}

/**
 * Pitch & roll: rotation that brings a measured plane normal to vertical (or
 * a measured axis to a target axis). Returns R to apply to the whole job.
 */
export function levelTo(normal: Vec3, target: Vec3 = [0, 0, 1]): Mat3 { return rotFromTo(unit(normal), unit(target)); }

export function transformPoints(P: Vec3[], opts: { t?: Vec3; R?: Mat3; s?: number; pivot?: Vec3 }): Vec3[] {
  const t = opts.t ?? [0, 0, 0], R = opts.R ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]], s = opts.s ?? 1, piv = opts.pivot ?? [0, 0, 0];
  return P.map(p => add(add(scl(matvec(R, sub(p, piv)), s), piv), t));
}

export interface SphereResult { center: Vec3; r: number; residuals: number[]; rms: number }

/** Sphere: linear algebraic start, then geometric least squares. */
export function sphereFit(P: Vec3[], fixedR?: number): SphereResult {
  if (P.length < (fixedR ? 3 : 4)) throw new Error(`Need at least ${fixedR ? 3 : 4} points for a sphere`);
  const c0 = centroid(P), Q = P.map(p => sub(p, c0));
  let start: number[];
  if (fixedR) start = [0, 0, 0];
  else {
    const A = Array.from({ length: 4 }, () => Array(4).fill(0)), b = Array(4).fill(0);
    for (const q of Q) { const row = [2 * q[0], 2 * q[1], 2 * q[2], 1], z = dot(q, q); for (let i = 0; i < 4; i++) { b[i] += row[i] * z; for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j]; } }
    const s = solveN(A, b);
    start = [s[0], s[1], s[2], Math.sqrt(Math.max(1e-12, s[3] + s[0] * s[0] + s[1] * s[1] + s[2] * s[2]))];
  }
  const fn = (x: number[]) => Q.map(q => Math.hypot(q[0] - x[0], q[1] - x[1], q[2] - x[2]) - (fixedR ?? x[3]));
  const lm = levenbergMarquardt(fn, start);
  return { center: add(c0, [lm.x[0], lm.x[1], lm.x[2]]), r: fixedR ?? lm.x[3], residuals: lm.residuals, rms: rms(lm.residuals) };
}

export interface CylinderResult {
  point: Vec3; dir: Vec3; r: number; residuals: number[]; rms: number;
  chainage: number[]; length: number; end1: Vec3; end2: Vec3; u: Vec3; v: Vec3;
  bearingDeg: number; slopeDeg: number; tiltFromVerticalDeg: number;
}

/**
 * Cylinder (pipe, vessel shell, pedestal): coarse search over axis directions
 * with a circle fit in each cross-section, then a 5-parameter geometric
 * least-squares refinement. Works on partial arcs (points on one side only).
 */
export function cylinderFit(P: Vec3[], fixedR?: number): CylinderResult {
  const need = fixedR ? 4 : 5;
  if (P.length < need) throw new Error(`Need at least ${need} points for a cylinder`);
  const c0 = centroid(P), Q = P.map(p => sub(p, c0));
  const basisOf = (d: Vec3): [Vec3, Vec3] => { const u = unit(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])); return [u, cross(d, u)]; };
  const dirs: Vec3[] = [];
  const N = 600, ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) { const z = (i + 0.5) / N, rr = Math.sqrt(1 - z * z); dirs.push([rr * Math.cos(i * ga), rr * Math.sin(i * ga), z]); }
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const q of Q) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += q[a] * q[b];
  const e = jacobi(C); for (let k = 0; k < 3; k++) dirs.push(unit(e.vecs.map(r => r[k]) as Vec3));
  const extent = Math.max(...Q.map(norm), 1e-9);
  let best: { cost: number; d: Vec3; cx: number; cy: number; r: number } | null = null;
  for (const d of dirs) {
    const [u, v] = basisOf(d);
    try {
      const c2 = circleFit2D(Q.map(q => [dot(q, u), dot(q, v)] as [number, number]), fixedR);
      const cost = c2.residuals.reduce((s, x) => s + x * x, 0);
      // a runaway radius means the projection is a strip, and its residuals cancel to zero in floating point
      if (isFinite(cost) && c2.r < 1e3 * extent && (!best || cost < best.cost)) best = { cost, d, cx: c2.cx, cy: c2.cy, r: c2.r };
    } catch { /* degenerate projection for this direction */ }
  }
  if (!best) throw new Error("Could not fit a cylinder to these points");
  const d0 = best.d, [u0, v0] = basisOf(d0);
  const geom = (x: number[]) => { const dir = unit(add(d0, add(scl(u0, x[0]), scl(v0, x[1])))); const o = add(scl(u0, x[2]), scl(v0, x[3])); return { dir, o, r: fixedR ?? x[4] }; };
  const fn = (x: number[]) => { const g = geom(x); return Q.map(q => { const w = sub(q, g.o); return norm(sub(w, scl(g.dir, dot(w, g.dir)))) - g.r; }); };
  const lm = levenbergMarquardt(fn, fixedR ? [0, 0, best.cx, best.cy] : [0, 0, best.cx, best.cy, best.r], { maxIter: 200 });
  const g = geom(lm.x);
  let dir = g.dir;
  const big = [0, 1, 2].reduce((b, i) => (Math.abs(dir[i]) > Math.abs(dir[b]) ? i : b), 0);
  if (Math.abs(dir[2]) > 0.2 ? dir[2] < 0 : dir[big] < 0) dir = scl(dir, -1);
  const t = Q.map(q => dot(sub(q, g.o), dir)), tmin = Math.min(...t), tmax = Math.max(...t);
  const onAxis = (tt: number): Vec3 => add(c0, add(g.o, scl(dir, tt)));
  const end1 = onAxis(tmin), end2 = onAxis(tmax), [u, v] = basisOf(dir);
  return {
    point: scl(add(end1, end2), 0.5), dir, r: g.r, residuals: lm.residuals, rms: rms(lm.residuals),
    chainage: t.map(x => x - tmin), length: tmax - tmin, end1, end2, u, v,
    bearingDeg: (Math.atan2(dir[0], dir[1]) / DEG + 360) % 360, slopeDeg: Math.asin(Math.max(-1, Math.min(1, dir[2]))) / DEG,
    tiltFromVerticalDeg: Math.acos(Math.min(1, Math.abs(dir[2]))) / DEG,
  };
}
