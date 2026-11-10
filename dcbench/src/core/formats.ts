// Field-data import/export: Leica GSI8/GSI16, generic CSV/TXT, Trimble JobXML.
import { Vec3, polarToLocal, add } from "./geom";

export interface SurveyPoint {
  name: string;
  p: Vec3;            // E, N, H (or X, Y, Z in a local DC frame)
  code?: string;
  source?: string;    // "gsi", "csv", "jxl", "instrument", "manual", "fit"
  raw?: { hz?: number; v?: number; sd?: number; hr?: number; station?: string };
}

export interface GsiStation { name: string; p: Vec3; hi: number }

// ---------- Leica GSI ----------
const GSI_UNIT_DECIMALS: Record<string, { scale: number; kind: "len" | "gon" | "deg" | "dms" | "mil" | "ft" }> = {
  "0": { scale: 1e-3, kind: "len" }, "1": { scale: 1e-3, kind: "ft" }, "2": { scale: 1e-5, kind: "gon" }, "3": { scale: 1e-5, kind: "deg" },
  "4": { scale: 1e-5, kind: "dms" }, "5": { scale: 1e-4, kind: "mil" }, "6": { scale: 1e-4, kind: "len" }, "7": { scale: 1e-4, kind: "ft" }, "8": { scale: 1e-5, kind: "len" },
};

interface GsiWord { wi: number; info: string; sign: string; data: string }

function splitWords(line: string): GsiWord[] {
  const l = line.replace(/\r?\n$/, "");
  const is16 = l.startsWith("*");
  const body = is16 ? l.slice(1) : l;
  const wlen = is16 ? 24 : 16;
  const words: GsiWord[] = [];
  for (let i = 0; i + 7 <= body.length; i += wlen) {
    const w = body.slice(i, i + wlen);
    if (!w.trim()) continue;
    // WI is 2 digits (pos 1-2); 3 digits only for the 3-digit word family (e.g. 531, 913), never for 11
    const two = w.slice(0, 2);
    const wi = two !== "11" && /\d/.test(w[2]) ? parseInt(w.slice(0, 3), 10) : parseInt(two, 10);
    words.push({ wi, info: w.slice(3, 6), sign: w[6], data: w.slice(7, wlen - 1) });
  }
  return words;
}

function numeric(w: GsiWord): number {
  const unit = GSI_UNIT_DECIMALS[w.info[2]] ?? GSI_UNIT_DECIMALS["0"];
  let v = parseInt(w.data, 10) * unit.scale * (w.sign === "-" ? -1 : 1);
  if (unit.kind === "gon") v = v * 0.9;                      // gon → degrees
  else if (unit.kind === "dms") { /* ddd.mmsss encoded as integer*1e-5 → convert */ const d = Math.trunc(v), m = Math.trunc((v - d) * 100), s = ((v - d) * 100 - m) * 100; v = d + m / 60 + s / 3600; }
  else if (unit.kind === "mil") v = v * 360 / 6400;
  else if (unit.kind === "ft") v = v * 0.3048;              // to metres
  return v;
}

/** Angle in degrees from a GSI angle word, honouring the unit digit. */
export interface GsiParseResult { points: SurveyPoint[]; stations: GsiStation[]; warnings: string[]; }

/**
 * Parse GSI8/GSI16. Coordinates words (81/82/83) are used directly; if a
 * block only carries Hz/V/SD (21/22/31) the point is reduced from the last
 * station block (84/85/86 + 88 hi) and reflector height (87).
 */
export function parseGSI(text: string): GsiParseResult {
  const points: SurveyPoint[] = [], stations: GsiStation[] = [], warnings: string[] = [];
  let station: GsiStation | undefined; let hr = 0;
  text.split(/\r?\n/).forEach((line, li) => {
    if (!line.trim()) return;
    const ws = splitWords(line);
    if (!ws.length) return;
    const get = (wi: number) => ws.find(w => w.wi === wi);
    const name = get(11)?.data.replace(/^0+(?!$)/, "") ?? `L${li + 1}`;
    if (get(41)) return; // code block
    if (get(87)) hr = numeric(get(87)!);
    const e0 = get(84), n0 = get(85), h0 = get(86);
    if (e0 && n0 && h0) {
      station = { name, p: [numeric(e0), numeric(n0), numeric(h0)], hi: get(88) ? numeric(get(88)!) : 0 };
      stations.push(station); return;
    }
    const e = get(81), n = get(82), h = get(83);
    const hz = get(21), v = get(22), sd = get(31);
    if (e && n) {
      points.push({ name, p: [numeric(e), numeric(n), h ? numeric(h) : 0], source: "gsi",
        raw: hz && v ? { hz: numeric(hz), v: numeric(v), sd: sd ? numeric(sd) : undefined, hr, station: station?.name } : undefined });
    } else if (hz && v && sd) {
      if (!station) { warnings.push(`Line ${li + 1}: polar observation before any station block, skipped`); return; }
      const d = polarToLocal(numeric(hz), numeric(v), numeric(sd));
      const p = add(station.p, [d[0], d[1], d[2] + station.hi - hr]);
      points.push({ name, p, source: "gsi", raw: { hz: numeric(hz), v: numeric(v), sd: numeric(sd), hr, station: station.name } });
    } else warnings.push(`Line ${li + 1}: no coordinates or polar data`);
  });
  return { points, stations, warnings };
}

function gsiWord(wi: number, value: number, unitDigit: string, decimals: number, gsi16: boolean): string {
  const width = gsi16 ? 16 : 8;
  const n = Math.round(Math.abs(value) * 10 ** decimals).toString().padStart(width, "0").slice(-width);
  return `${String(wi).padStart(2, "0")}..0${unitDigit}${value < 0 ? "-" : "+"}${n} `;
}
/** Write coordinate blocks (11, 81, 82, 83) in GSI8 or GSI16, metres with 3 (GSI8) or 4 (GSI16) decimals. */
export function writeGSI(points: SurveyPoint[], gsi16 = true): string {
  const width = gsi16 ? 16 : 8, dec = gsi16 ? 4 : 3, unit = gsi16 ? "6" : "0";
  return points.map(pt => {
    const id = pt.name.slice(-width).padStart(width, "0");
    return `${gsi16 ? "*" : ""}11....+${id} ` + gsiWord(81, pt.p[0], unit, dec, gsi16) + gsiWord(82, pt.p[1], unit, dec, gsi16) + gsiWord(83, pt.p[2], unit, dec, gsi16);
  }).join("\r\n") + "\r\n";
}

// ---------- CSV / TXT ----------
export type CsvOrder = "PENZ" | "PNEZ" | "PENZD" | "PNEZD" | "auto";
/** Name,E,N,H[,code] or Name,N,E,H[,code]. Header lines and # comments are skipped. */
export function parseCSV(text: string, order: CsvOrder = "auto"): { points: SurveyPoint[]; warnings: string[] } {
  const points: SurveyPoint[] = [], warnings: string[] = [];
  let detected: CsvOrder = order;
  text.split(/\r?\n/).forEach((line, li) => {
    const l = line.trim(); if (!l || l.startsWith("#")) return;
    const f = l.split(/[,\t;]+|\s{2,}|\s(?=[-\d.])/).map(s => s.trim()).filter(Boolean);
    const nums = f.map(Number);
    let name: string, vals: number[], code: string | undefined;
    if (isNaN(nums[0])) { name = f[0]; vals = nums.slice(1); } else { name = `P${points.length + 1}`; vals = nums; }
    if (vals.length < 2 || isNaN(vals[0]) || isNaN(vals[1])) {
      if (li === 0 || /^[a-z]/i.test(l)) return; // header
      warnings.push(`Line ${li + 1}: unreadable`); return;
    }
    if (vals.length >= 4 && isNaN(vals[3])) code = f[f.length - 1];
    else if (f.length > (isNaN(nums[0]) ? 4 : 3) && isNaN(nums[nums.length - 1])) code = f[f.length - 1];
    if (detected === "auto") {
      detected = "PENZ";
      const h = l.toLowerCase(); if (/north|^.*\bn\b.*\be\b/.test(h)) detected = "PNEZ";
    }
    const ne = detected.startsWith("PN");
    const p: Vec3 = ne ? [vals[1], vals[0], vals[2] ?? 0] : [vals[0], vals[1], vals[2] ?? 0];
    points.push({ name, p, code, source: "csv" });
  });
  return { points, warnings };
}

export function writeCSV(points: SurveyPoint[], order: "PENZ" | "PNEZ" = "PENZ", decimals = 4): string {
  const head = order === "PENZ" ? "Name,E,N,H,Code" : "Name,N,E,H,Code";
  return head + "\n" + points.map(pt => {
    const [e, n, h] = pt.p.map(v => v.toFixed(decimals));
    return `${pt.name},${order === "PENZ" ? `${e},${n}` : `${n},${e}`},${h},${pt.code ?? ""}`;
  }).join("\n") + "\n";
}

// ---------- Trimble JobXML (.jxl) ----------
/** Reads <Point> records (Reductions/Point with Grid North/East/Elevation) from a JobXML export. */
export function parseJXL(xml: string): { points: SurveyPoint[]; warnings: string[] } {
  const points: SurveyPoint[] = [], warnings: string[] = [];
  const doc = typeof DOMParser !== "undefined" ? new DOMParser().parseFromString(xml, "application/xml") : null;
  if (!doc) { // minimal regex fallback for non-DOM environments
    const re = /<Point[^>]*>([\s\S]*?)<\/Point>/g; let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const b = m[1], g = (tag: string) => { const r = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(b); return r ? r[1] : undefined; };
      const name = g("Name"), n = g("North"), e = g("East"), h = g("Elevation");
      if (name && n && e) points.push({ name, p: [+e, +n, h ? +h : 0], code: g("Code") ?? undefined, source: "jxl" });
    }
    return { points, warnings };
  }
  doc.querySelectorAll("Point").forEach(el => {
    const g = (tag: string) => el.querySelector(tag)?.textContent?.trim();
    const name = g("Name"), n = g("North"), e = g("East"), h = g("Elevation");
    if (name && n && e) points.push({ name, p: [+e, +n, h ? +h : 0], code: g("Code") ?? undefined, source: "jxl" });
  });
  if (!points.length) warnings.push("No reduced <Point> records found in JobXML");
  return { points, warnings };
}

/** Pick a parser by extension / content sniffing. */
export function importAny(text: string, filename: string): { points: SurveyPoint[]; stations?: GsiStation[]; warnings: string[] } {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "gsi" || /^\*?\d{2}\.{2,4}[+-]/m.test(text)) return parseGSI(text);
  if (ext === "jxl" || /<JOBFile/i.test(text)) return parseJXL(text);
  return parseCSV(text);
}
