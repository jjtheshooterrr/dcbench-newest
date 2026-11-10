// Least-squares fitting routines used in dimensional control.
import { Vec3, Mat3, add, sub, scl, dot, cross, unit, norm, matvec, centroid, jacobi, quatToMat, solve3, solve2, rms, rotFromTo, eulerZYX, DEG } from "./geom";

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
}

/**
 * Flange: bolt holes → PCD circle + normal; optional separate face points →
 * face plane (flatness, gap between hole plane and face plane).
 */
export function flangeFit(holes: Vec3[], opts: { nHoles: number; nominalPCD: number; axis: "x" | "y" | "z"; facePoints?: Vec3[] }): FlangeResult {
  const circle = circleFit3D(holes);
  const axisV: Vec3 = opts.axis === "x" ? [1, 0, 0] : opts.axis === "y" ? [0, 1, 0] : [0, 0, 1];
  const faceAngleDeg = Math.acos(Math.min(1, Math.abs(dot(circle.n, axisV)))) / DEG;
  const nominal = 360 / opts.nHoles;
  const sorted = [...circle.angles].sort((a, b) => a - b);
  const gaps = sorted.map((a, i) => ((sorted[(i + 1) % sorted.length] - a) + 360) % 360);
  const res: FlangeResult = {
    circle, pcd: 2 * circle.r, pcdError: 2 * circle.r - opts.nominalPCD, faceAngleDeg,
    pitchDeg: Math.atan2(circle.n[0], circle.n[2]) / DEG, rollDeg: Math.atan2(circle.n[1], circle.n[2]) / DEG,
    nominalSpacingDeg: nominal, maxSpacingErrorDeg: Math.max(...gaps.map(g => Math.abs(g - nominal))), holeAngles: circle.angles,
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
