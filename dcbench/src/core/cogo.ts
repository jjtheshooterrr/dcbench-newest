// Coordinate geometry: inverse, point-to-line, point-to-plane, line-line closest approach.
import { Vec3, sub, add, scl, dot, cross, norm, unit, DEG } from "./geom";

export function inverse(a: Vec3, b: Vec3) {
  const d = sub(b, a), horiz = Math.hypot(d[0], d[1]), slope = norm(d);
  return {
    dE: d[0], dN: d[1], dH: d[2], horiz, slope,
    bearingDeg: (Math.atan2(d[0], d[1]) / DEG + 360) % 360,
    zenithDeg: slope ? Math.acos(d[2] / slope) / DEG : 0,
    gradePct: horiz ? (d[2] / horiz) * 100 : NaN,
  };
}

/** Perpendicular from p to the line a→b. horizOffset is signed: positive = right of the line looking a→b. */
export function pointToLine(p: Vec3, a: Vec3, b: Vec3) {
  if (norm(sub(b, a)) < 1e-12) throw new Error("Line start and end are the same point");
  const dir = unit(sub(b, a)), chainage = dot(sub(p, a), dir), foot = add(a, scl(dir, chainage)), off = sub(p, foot);
  const right = dir[0] * off[1] - dir[1] * off[0] < 0;
  return { foot, chainage, offset: norm(off), horizOffset: Math.hypot(off[0], off[1]) * (right ? 1 : -1), dH: off[2] };
}

export function pointToPlane(p: Vec3, c: Vec3, n: Vec3) {
  const offset = dot(sub(p, c), n);
  return { offset, foot: sub(p, scl(n, offset)) };
}

/** Closest approach of lines a1→a2 and b1→b2 (treated as infinite). */
export function lineLine(a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3) {
  const u = sub(a2, a1), v = sub(b2, b1), w = sub(a1, b1);
  const A = dot(u, u), B = dot(u, v), C = dot(v, v), D = dot(u, w), E = dot(v, w), den = A * C - B * B;
  if (den < 1e-14 * A * C || A === 0 || C === 0) throw new Error("Lines are parallel (or a line has zero length)");
  const s = (B * E - C * D) / den, t = (A * E - B * D) / den;
  const pa = add(a1, scl(u, s)), pb = add(b1, scl(v, t));
  return { onA: pa, onB: pb, point: scl(add(pa, pb), 0.5), gap: norm(sub(pa, pb)), angleDeg: Math.acos(Math.min(1, Math.abs(B) / Math.sqrt(A * C))) / DEG };
}

/** Angle at vertex between rays to a and b, in degrees. */
export function angleAt(vertex: Vec3, a: Vec3, b: Vec3) {
  const u = unit(sub(a, vertex)), v = unit(sub(b, vertex));
  return Math.atan2(norm(cross(u, v)), dot(u, v)) / DEG;
}
