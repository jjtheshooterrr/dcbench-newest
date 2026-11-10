// Small dense linear algebra for 3D survey work. No dependencies.
export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scl = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec3): Vec3 => { const n = norm(a) || 1; return scl(a, 1 / n); };
export const matvec = (M: Mat3, v: Vec3): Vec3 => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
export const transpose = (M: Mat3): Mat3 => [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]];
export function matmul(A: Mat3, B: Mat3): Mat3 {
  const r = [0, 1, 2].map(i => [0, 1, 2].map(j => A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]));
  return r as Mat3;
}
export const I3 = (): Mat3 => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export const centroid = (P: Vec3[]): Vec3 => scl(P.reduce(add, [0, 0, 0]), 1 / P.length);
export const rms = (r: number[]) => Math.sqrt(r.reduce((s, v) => s + v * v, 0) / r.length);
export const DEG = Math.PI / 180;

/** Jacobi eigen-decomposition of a symmetric n×n matrix. vecs are columns. */
export function jacobi(Ain: number[][]): { vals: number[]; vecs: number[][] } {
  const n = Ain.length;
  const A = Ain.map(r => r.slice());
  const V: number[][] = A.map((_, i) => A.map((_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  return { vals: A.map((r, i) => r[i]), vecs: V };
}

export function quatToMat(q: number[]): Mat3 {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** Euler angles (deg) with R = Rz·Ry·Rx. Returns [rotX, rotY, rotZ]. */
export function eulerZYX(R: Mat3): Vec3 {
  const pitch = Math.asin(-Math.max(-1, Math.min(1, R[2][0])));
  const roll = Math.atan2(R[2][1], R[2][2]);
  const yaw = Math.atan2(R[1][0], R[0][0]);
  return [roll / DEG, pitch / DEG, yaw / DEG];
}

export function rotZYX(rxDeg: number, ryDeg: number, rzDeg: number): Mat3 {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rxDeg * DEG), Math.sin(rxDeg * DEG), Math.cos(ryDeg * DEG), Math.sin(ryDeg * DEG), Math.cos(rzDeg * DEG), Math.sin(rzDeg * DEG)];
  const Rx: Mat3 = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const Ry: Mat3 = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rz: Mat3 = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  return matmul(Rz, matmul(Ry, Rx));
}

/** Rotation taking unit vector a onto unit vector b (Rodrigues). */
export function rotFromTo(a: Vec3, b: Vec3): Mat3 {
  const v = cross(a, b), c = dot(a, b), s = norm(v);
  if (s < 1e-12) return c > 0 ? I3() : rotZYX(180, 0, 0);
  const [x, y, z] = scl(v, 1 / s);
  const K: Mat3 = [[0, -z, y], [z, 0, -x], [-y, x, 0]];
  const K2 = matmul(K, K);
  const R = I3();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i][j] += s * K[i][j] + (1 - c) * K2[i][j];
  return R;
}

export function solve3(A: number[][], b: number[]): number[] {
  const [[a, b1, c], [d, e, f], [g, h, i]] = A;
  const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-300) throw new Error("Singular system (points are collinear or coincident)");
  return [
    (b[0] * (e * i - f * h) - b1 * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - b1 * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ];
}
export function solve2(A: number[][], b: number[]): number[] {
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  if (Math.abs(det) < 1e-300) throw new Error("Singular system");
  return [(b[0] * A[1][1] - A[0][1] * b[1]) / det, (A[0][0] * b[1] - b[0] * A[1][0]) / det];
}

/** Polar (Hz, V, slope distance) to local dE, dN, dH. Hz/V in degrees, V zenith (0 = up). */
export function polarToLocal(hzDeg: number, vDeg: number, slope: number): Vec3 {
  const hz = hzDeg * DEG, v = vDeg * DEG;
  const hd = slope * Math.sin(v);
  return [hd * Math.sin(hz), hd * Math.cos(hz), slope * Math.cos(v)];
}
