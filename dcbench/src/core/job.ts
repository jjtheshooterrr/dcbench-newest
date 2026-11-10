// Job model: everything a DC survey job holds, saved as a .dcj JSON file.
import { Vec3, Mat3 } from "./geom";
import { SurveyPoint } from "./formats";

export type FitKind = "bestfit3d" | "bestfit2d" | "plane" | "circle" | "flange" | "corner" | "line" | "transform";

export interface FitRecord {
  id: string;
  kind: FitKind;
  title: string;
  created: string;
  inputs: Record<string, unknown>;   // point names, options
  result: Record<string, unknown>;   // serialisable result (numbers, arrays)
  report: string;                    // text block as shown to the user
}

export interface Job {
  schema: 1;
  name: string;
  client?: string;
  site?: string;
  surveyor?: string;
  instrument?: { name?: string; serial?: string };
  units: "mm" | "m" | "in";
  tolerance: number;                 // in job units
  created: string;
  modified: string;
  points: SurveyPoint[];
  fits: FitRecord[];
  history: { at: string; what: string }[];
}

export function newJob(name = "Untitled job"): Job {
  const now = new Date().toISOString();
  return { schema: 1, name, units: "mm", tolerance: 3, created: now, modified: now, points: [], fits: [], history: [] };
}

export function serializeJob(j: Job): string { return JSON.stringify({ ...j, modified: new Date().toISOString() }, null, 1); }
export function parseJob(text: string): Job {
  const j = JSON.parse(text);
  if (j.schema !== 1 || !Array.isArray(j.points)) throw new Error("Not a DC Bench job file");
  return j as Job;
}

/** Points are stored in metres internally; display/entry in job units. */
export const UNIT_FACTOR: Record<Job["units"], number> = { mm: 1000, m: 1, in: 39.3700787 };
export const toUnits = (m: number, u: Job["units"]) => m * UNIT_FACTOR[u];
export const fromUnits = (v: number, u: Job["units"]) => v / UNIT_FACTOR[u];

export function upsertPoints(job: Job, pts: SurveyPoint[], mode: "replace" | "skip" | "rename" = "replace") {
  const byName = new Map(job.points.map((p, i) => [p.name, i]));
  for (const p of pts) {
    const i = byName.get(p.name);
    if (i === undefined) { job.points.push(p); byName.set(p.name, job.points.length - 1); continue; }
    if (mode === "replace") job.points[i] = p;
    else if (mode === "rename") { let k = 1, nm = p.name; while (byName.has(nm)) nm = `${p.name}_${k++}`; job.points.push({ ...p, name: nm }); byName.set(nm, job.points.length - 1); }
  }
  job.history.push({ at: new Date().toISOString(), what: `Imported ${pts.length} point(s)` });
}

export function applyTransformToJob(job: Job, R: Mat3, t: Vec3, s = 1, names?: string[]) {
  const set = names ? new Set(names) : null;
  for (const p of job.points) {
    if (set && !set.has(p.name)) continue;
    const q = p.p;
    p.p = [
      s * (R[0][0] * q[0] + R[0][1] * q[1] + R[0][2] * q[2]) + t[0],
      s * (R[1][0] * q[0] + R[1][1] * q[1] + R[1][2] * q[2]) + t[1],
      s * (R[2][0] * q[0] + R[2][1] * q[1] + R[2][2] * q[2]) + t[2],
    ];
  }
  job.history.push({ at: new Date().toISOString(), what: `Transformed ${set ? set.size : job.points.length} point(s)` });
}
