// A synthetic example job so every screen has something to work on. Coordinates in metres.
// Every point carries an EXAMPLE code; none of this is survey data.
import { Vec3, rotZYX, matvec, add, scl, unit, cross } from "../core/geom";
import { SurveyPoint } from "../core/formats";

export function samplePoints(): SurveyPoint[] {
  let seed = 20261111;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 - 0.5; };
  const jit = (mm: number): Vec3 => [rnd() * mm / 1000, rnd() * mm / 1000, rnd() * mm / 1000];
  const out: SurveyPoint[] = [];
  const push = (name: string, p: Vec3, code: string) => out.push({ name, p, code: `EXAMPLE ${code}`, source: "sample" });

  // design control and the same targets as measured from an arbitrary station
  const design: [string, Vec3][] = [["TP1", [1, 2, 0.1]], ["TP2", [4.5, 2.05, 0.11]], ["TP3", [4.48, 5.6, 0.095]], ["TP4", [1.02, 5.58, 0.105]], ["TP5", [2.75, 3.8, 1.85]], ["TP6", [2.8, 2.1, 0.9]]];
  const R = rotZYX(0.35, -0.2, 12.5), t: Vec3 = [10.8505, -1.2203, 0.4452];
  for (const [n, p] of design) push(n, p, "DESIGN");
  for (const [n, p] of design) { const m = add(add(matvec(R, p), t), jit(0.8)); if (n === "TP5") m[1] += 0.0065; push(n + "_M", m, "MEASURED"); }

  // 8-hole flange on a horizontal run (face looks along +E), 203.2 PCD, clocked 0.6° off two-holed
  const fc: Vec3 = [8.2, 3.4, 1.25], fn = unit([1, 0.012, -0.008]), up = unit(add([0, 0, 1], scl(fn, 0.008))), side = cross(fn, up);
  for (let i = 0; i < 8; i++) { const a = ((i + 0.5) * 45 + 0.6) * Math.PI / 180; push(`H${i + 1}`, add(add(fc, add(scl(up, 0.1016 * Math.cos(a)), scl(side, 0.1016 * Math.sin(a)))), jit(0.5)), "BOLT HOLE"); }
  for (let i = 0; i < 6; i++) { const a = i * 60 * Math.PI / 180; push(`F${i + 1}`, add(add(fc, add(scl(up, 0.135 * Math.cos(a)), scl(side, 0.135 * Math.sin(a)))), scl(fn, rnd() * 0.0006)), "FLANGE FACE"); }

  // pipe behind the flange: 219.1 OD, shots on the visible side only
  const pu = up, pv = side;
  for (let k = 0; k < 4; k++) for (let i = 0; i < 6; i++) { const a = (-70 + i * 28) * Math.PI / 180; push(`PP${k * 6 + i + 1}`, add(add(add(fc, scl(fn, -0.15 - k * 0.35)), add(scl(pu, 0.10955 * Math.cos(a)), scl(pv, 0.10955 * Math.sin(a)))), jit(0.6)), "PIPE"); }

  // deck plate, slightly out of level
  let d = 1;
  for (let x = 0; x <= 3; x++) for (let y = 0; y <= 2; y++) push(`DK${d++}`, [6 + x * 0.6, 5 + y * 0.6, 0.02 + 0.0031 * x - 0.0018 * y + rnd() * 0.0008], "DECK");

  // 145 mm sphere target
  for (let i = 0; i < 10; i++) { const th = 0.25 + 0.12 * i, ph = i * 1.3; push(`SP${i + 1}`, add([5.2, 6.4, 1.1], add(scl([Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)], 0.0725), jit(0.2))), "SPHERE"); }
  return out;
}
