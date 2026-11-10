// Minimal DXF R12 (AC1009) writer: layers, POINT, LINE, CIRCLE, TEXT, 3DFACE.
// R12 ASCII is read by every CAD package (AutoCAD, BricsCAD, MicroStation, Navisworks, Revit import).
import { Vec3 } from "./geom";

type Entity = string;
const g = (code: number, v: string | number) => `${code}\n${typeof v === "number" ? fmt(v) : v}\n`;
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(6));

export class DxfWriter {
  private ents: Entity[] = [];
  private layers = new Map<string, number>(); // name → ACI colour
  constructor() { this.layer("0", 7); }
  layer(name: string, color = 7) { this.layers.set(name, color); return this; }
  point(p: Vec3, layer = "0") { this.ents.push(g(0, "POINT") + g(8, layer) + g(10, p[0]) + g(20, p[1]) + g(30, p[2])); return this; }
  line(a: Vec3, b: Vec3, layer = "0") { this.ents.push(g(0, "LINE") + g(8, layer) + g(10, a[0]) + g(20, a[1]) + g(30, a[2]) + g(11, b[0]) + g(21, b[1]) + g(31, b[2])); return this; }
  /** Circle in a plane with normal n (DXF uses OCS: extrusion = normal, centre given in OCS coords). */
  circle(center: Vec3, r: number, n: Vec3 = [0, 0, 1], layer = "0") {
    const [ox, oy, oz] = toOCS(center, n);
    this.ents.push(g(0, "CIRCLE") + g(8, layer) + g(10, ox) + g(20, oy) + g(30, oz) + g(40, r) + g(210, n[0]) + g(220, n[1]) + g(230, n[2]));
    return this;
  }
  text(p: Vec3, txt: string, h = 0.05, layer = "0") { this.ents.push(g(0, "TEXT") + g(8, layer) + g(10, p[0]) + g(20, p[1]) + g(30, p[2]) + g(40, h) + g(1, txt)); return this; }
  face(a: Vec3, b: Vec3, c: Vec3, d: Vec3 = c, layer = "0") {
    this.ents.push(g(0, "3DFACE") + g(8, layer) + [a, b, c, d].map((p, i) => g(10 + i, p[0]) + g(20 + i, p[1]) + g(30 + i, p[2])).join(""));
    return this;
  }
  /** Named point with a small cross marker and label. */
  labelledPoint(p: Vec3, name: string, size = 0.02, layer = "0") {
    this.point(p, layer);
    this.line([p[0] - size, p[1], p[2]], [p[0] + size, p[1], p[2]], layer);
    this.line([p[0], p[1] - size, p[2]], [p[0], p[1] + size, p[2]], layer);
    this.line([p[0], p[1], p[2] - size], [p[0], p[1], p[2] + size], layer);
    this.text([p[0] + size, p[1] + size, p[2]], name, size * 1.5, layer);
    return this;
  }
  toString(): string {
    let s = g(0, "SECTION") + g(2, "HEADER") + g(9, "$ACADVER") + g(1, "AC1009") + g(9, "$INSUNITS") + g(70, 6) + g(0, "ENDSEC");
    s += g(0, "SECTION") + g(2, "TABLES") + g(0, "TABLE") + g(2, "LAYER") + g(70, this.layers.size);
    for (const [name, color] of this.layers) s += g(0, "LAYER") + g(2, name) + g(70, 0) + g(62, color) + g(6, "CONTINUOUS");
    s += g(0, "ENDTAB") + g(0, "ENDSEC");
    s += g(0, "SECTION") + g(2, "ENTITIES") + this.ents.join("") + g(0, "ENDSEC") + g(0, "EOF");
    return s;
  }
}

// Arbitrary Axis Algorithm (DXF spec) to express a WCS point in the OCS of normal n.
function toOCS(p: Vec3, n: Vec3): Vec3 {
  const ax: Vec3 = Math.abs(n[0]) < 1 / 64 && Math.abs(n[1]) < 1 / 64 ? cross([0, 1, 0], n) : cross([0, 0, 1], n);
  const X = unit(ax), Y = unit(cross(n, X));
  return [dot(p, X), dot(p, Y), dot(p, n)];
}
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => { const n = Math.hypot(...a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
