import { Vec3, Mat3, rotZYX, centroid, eulerZYX } from "./core/geom";
import { bestFit, planeFit, circleFit3D, flangeFit, cornerFit, lineFit, levelTo, transformPoints } from "./core/fits";
import { SurveyPoint, importAny, writeCSV, writeGSI } from "./core/formats";
import { Job, newJob, serializeJob, parseJob, upsertPoints, applyTransformToJob, toUnits, fromUnits, UNIT_FACTOR, FitRecord } from "./core/job";
import { GeoComClient, SimulatedInstrument, BAP_PRG, Transport, Measurement } from "./core/geocom";
import { DxfWriter } from "./core/dxf";
import { openTextFile, saveTextFile, toast } from "./ui/io";
import { drawPlot, PlotSpec } from "./ui/plot";

// ---------- state ----------
let job: Job = newJob();
let jobPath: string | null = null;
let selected = new Set<string>();
let screen = "job";
let client: GeoComClient | null = null;
let instrumentLabel = "Not connected";
let lastMeasure: Measurement | null = null;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const el = (html: string) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const f = (m: number, dec = 3) => toUnits(m, job.units).toFixed(dec);          // metres → job units string
const fa = (deg: number) => deg.toFixed(4) + "°";
const flagOf = (m: number) => { const v = Math.abs(toUnits(m, job.units)); return v > job.tolerance ? "bad" : v > job.tolerance * 0.66 ? "warn" : "ok"; };
const pill = (k: string) => `<span class="pill ${k}">${k === "ok" ? "in tol" : k === "warn" ? "near" : "out"}</span>`;
const pointsByName = (names: string[]) => names.map(n => job.points.find(p => p.name === n)!).filter(Boolean);
const stamp = () => `DC Bench · ${job.name} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} · units ${job.units} · tol ±${job.tolerance}`;

// ---------- layout ----------
const SCREENS: { id: string; label: string; grp: string }[] = [
  { id: "job", label: "Job & points", grp: "Job" }, { id: "instrument", label: "Instrument", grp: "Job" },
  { id: "bestfit", label: "2D / 3D best-fit", grp: "Fits" }, { id: "plane", label: "Plane fit", grp: "Fits" }, { id: "circle", label: "Circle fit", grp: "Fits" },
  { id: "line", label: "Line / axis fit", grp: "Fits" }, { id: "corner", label: "Corner fit", grp: "Fits" },
  { id: "flange", label: "Flange", grp: "Piping" },
  { id: "transform", label: "Translate / rotate", grp: "Geometry" }, { id: "level", label: "Pitch & roll (level)", grp: "Geometry" },
  { id: "cad", label: "Plot to CAD (DXF)", grp: "Output" }, { id: "report", label: "Job report", grp: "Output" },
];

function renderShell() {
  const app = $("#app"); app.innerHTML = "";
  app.append(el(`<div class="menubar"><span class="brand">DC Bench</span>
    <button id="mNew">New</button><button id="mOpen">Open…</button><button id="mSave">Save</button><button id="mSaveAs">Save as…</button>
    <button id="mImport">Import points…</button><button id="mExport">Export points…</button>
    <span class="spacer"></span><span class="jobname" id="jobName"></span></div>`));
  const rail = el(`<nav class="rail"></nav>`); let lastGrp = "";
  for (const s of SCREENS) { if (s.grp !== lastGrp) { rail.append(el(`<div class="grp">${s.grp}</div>`)); lastGrp = s.grp; } const b = el(`<button data-id="${s.id}">${s.label}</button>`); b.onclick = () => show(s.id); rail.append(b); }
  app.append(rail, el(`<main class="work" id="work"></main>`), el(`<div class="status"><span><span class="dot" id="connDot"></span><span id="connText"></span></span><span id="stPoints"></span><span id="stUnits"></span><span class="spacer"></span><span id="stPath"></span></div>`));
  $("#mNew").onclick = () => { if (confirmLose()) { job = newJob(); jobPath = null; selected.clear(); show("job"); } };
  $("#mOpen").onclick = openJob; $("#mSave").onclick = () => saveJob(false); $("#mSaveAs").onclick = () => saveJob(true);
  $("#mImport").onclick = importPoints; $("#mExport").onclick = exportPoints;
  document.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveJob(e.shiftKey); } if ((e.ctrlKey || e.metaKey) && e.key === "o") { e.preventDefault(); openJob(); } });
}
function confirmLose() { return job.points.length === 0 || window.confirm("Discard the current job?"); }
function refreshStatus() {
  $("#jobName").textContent = job.name; $("#stPoints").textContent = `${job.points.length} points`; $("#stUnits").textContent = `${job.units} · tol ±${job.tolerance}`;
  $("#stPath").textContent = jobPath ?? "(unsaved)"; $("#connText").textContent = instrumentLabel; $("#connDot").classList.toggle("on", !!client);
  document.querySelectorAll<HTMLButtonElement>(".rail button").forEach(b => b.setAttribute("aria-current", String(b.dataset.id === screen)));
}
function show(id: string) { screen = id; const w = $("#work"); w.innerHTML = ""; (RENDER[id] ?? RENDER.job)(w); refreshStatus(); }

// ---------- job I/O ----------
async function openJob() {
  if (!confirmLose()) return;
  const r = await openTextFile([{ name: "DC Bench job", extensions: ["dcj", "json"] }]); if (!r) return;
  try { job = parseJob(r.text); jobPath = r.name; selected.clear(); show("job"); toast(`Opened ${r.name}`); } catch (e: any) { alert(e.message); }
}
async function saveJob(as: boolean) {
  const name = jobPath && !as ? jobPath : `${job.name.replace(/[^\w.-]+/g, "_")}.dcj`;
  const p = await saveTextFile(name, serializeJob(job), [{ name: "DC Bench job", extensions: ["dcj"] }]);
  if (p) { jobPath = p; toast("Saved"); refreshStatus(); }
}
async function importPoints() {
  const r = await openTextFile([{ name: "Survey data", extensions: ["gsi", "csv", "txt", "jxl", "xml", "asc"] }]); if (!r) return;
  try {
    const res = importAny(r.text, r.name);
    upsertPoints(job, res.points.map(p => ({ ...p, source: p.source ?? "file" })), "replace");
    toast(`Imported ${res.points.length} points from ${r.name}` + (res.warnings.length ? ` (${res.warnings.length} warnings)` : ""));
    if (res.warnings.length) console.warn(res.warnings);
    show("job");
  } catch (e: any) { alert("Import failed: " + e.message); }
}
async function exportPoints() {
  const which = window.prompt("Export format: csv, gsi16, gsi8", "csv")?.toLowerCase(); if (!which) return;
  const pts = selected.size ? job.points.filter(p => selected.has(p.name)) : job.points;
  if (which.startsWith("gsi")) await saveTextFile(`${job.name}.gsi`, writeGSI(pts, which === "gsi16"), [{ name: "Leica GSI", extensions: ["gsi"] }]);
  else await saveTextFile(`${job.name}.csv`, writeCSV(pts, "PENZ", 4), [{ name: "CSV", extensions: ["csv"] }]);
  toast(`Exported ${pts.length} points`);
}

// ---------- shared widgets ----------
function pointTable(pts: SurveyPoint[], opts: { selectable?: boolean; extra?: (p: SurveyPoint, i: number) => string; extraHead?: string[] } = {}) {
  const head = ["Point", "E / X", "N / Y", "H / Z", "Code", "Source", ...(opts.extraHead ?? [])];
  const t = el(`<div class="tbl"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody></tbody></table></div>`);
  const tb = $("tbody", t);
  pts.forEach((p, i) => {
    const tr = el(`<tr data-name="${p.name}" class="${selected.has(p.name) ? "sel" : ""}"><td>${p.name}</td><td>${f(p.p[0])}</td><td>${f(p.p[1])}</td><td>${f(p.p[2])}</td><td>${p.code ?? ""}</td><td>${p.source ?? ""}</td>${opts.extra ? opts.extra(p, i) : ""}</tr>`);
    if (opts.selectable) tr.onclick = (e) => { if (!e.shiftKey && !e.ctrlKey) selected.clear(); selected.has(p.name) ? selected.delete(p.name) : selected.add(p.name); t.querySelectorAll("tr").forEach(r => r.classList.toggle("sel", selected.has((r as HTMLElement).dataset.name!))); onSelChange?.(); };
    tb.append(tr);
  });
  return t;
}
let onSelChange: (() => void) | null = null;

/** Multi-select list of job points (used as fit input). */
function pointPicker(label: string, preset: string[] = []): { el: HTMLElement; names: () => string[] } {
  const box = el(`<div class="panel"><h2>${label} <span class="hint">Ctrl/Shift-click to multi-select, or type names</span></h2>
    <select multiple size="8" style="width:100%;font-family:var(--mono)">${job.points.map(p => `<option value="${p.name}" ${preset.includes(p.name) ? "selected" : ""}>${p.name.padEnd(10)} ${f(p.p[0])}  ${f(p.p[1])}  ${f(p.p[2])}</option>`).join("")}</select>
    <div class="actions"><input type="text" placeholder="e.g. H1-H8 or TP1,TP2" style="flex:1"><button class="btn sel">Select</button><button class="btn all">All</button><button class="btn fromsel">Use job selection</button></div></div>`);
  const sel = $("select", box) as HTMLSelectElement, inp = $("input", box) as HTMLInputElement;
  const pick = (names: string[]) => { const s = new Set(names); Array.from(sel.options).forEach(o => (o.selected = s.has(o.value))); };
  $(".sel", box).onclick = () => pick(expandNames(inp.value)); $(".all", box).onclick = () => pick(job.points.map(p => p.name)); $(".fromsel", box).onclick = () => pick([...selected]);
  return { el: box, names: () => Array.from(sel.selectedOptions).map(o => o.value) };
}
function expandNames(s: string): string[] {
  const out: string[] = [];
  for (const tok of s.split(/[,\s]+/).filter(Boolean)) {
    const m = /^([A-Za-z_]*)(\d+)-(?:[A-Za-z_]*)?(\d+)$/.exec(tok);
    if (m) { for (let i = +m[2]; i <= +m[3]; i++) out.push(m[1] + i); } else out.push(tok);
  }
  return out;
}
function resultPanel(title: string): { el: HTMLElement; stats: (kv: [string, string | number][]) => void; table: (html: string) => void; report: (txt: string) => void; plot: (spec: PlotSpec) => void; error: (m: string) => void; txt: string } {
  const box = el(`<div><section class="panel"><h2>${title}</h2><div class="stat"></div><div class="tbl"></div><div class="err" hidden></div></section>
    <div class="row" style="margin-top:14px"><section class="panel"><h2>Plot <span class="hint"></span></h2><canvas width="900" height="560"></canvas></section>
    <section class="panel"><h2>Report <span class="hint"><button class="btn cp">Copy</button> <button class="btn sv">Save to job</button></span></h2><pre class="rep"></pre></section></div></div>`);
  const r = { el: box, txt: "",
    stats: (kv: [string, string | number][]) => { $(".stat", box).innerHTML = kv.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join(""); },
    table: (h: string) => { $(".tbl", box).innerHTML = h; }, report: (t: string) => { r.txt = t; $("pre", box).textContent = t; },
    plot: (spec: PlotSpec) => drawPlot($("canvas", box) as HTMLCanvasElement, spec, $(".panel .hint", box.children[1] as HTMLElement)),
    error: (m: string) => { const e = $(".err", box); e.hidden = !m; e.textContent = m; } };
  $(".cp", box).onclick = () => navigator.clipboard.writeText(r.txt).then(() => toast("Report copied"));
  return r;
}
function saveFit(kind: FitRecord["kind"], title: string, inputs: Record<string, unknown>, result: Record<string, unknown>, report: string) {
  job.fits.push({ id: `${kind}-${Date.now()}`, kind, title, created: new Date().toISOString(), inputs, result, report });
  toast("Fit saved to job"); refreshStatus();
}
const tableHTML = (h: string[], rows: string[][]) => `<table><thead><tr>${h.map(x => `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${i === r.length - 1 && c.startsWith("<span") ? ' class="flag"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
const unitF = () => UNIT_FACTOR[job.units];

// ---------- screens ----------
const RENDER: Record<string, (w: HTMLElement) => void> = {
  job(w) {
    const hdr = el(`<section class="panel"><h2>Job</h2><div class="kv">
      <label>Job name</label><input type="text" id="jn" value="${job.name}">
      <label>Client</label><input type="text" id="jc" value="${job.client ?? ""}">
      <label>Site / vessel</label><input type="text" id="js" value="${job.site ?? ""}">
      <label>Surveyor</label><input type="text" id="jv" value="${job.surveyor ?? ""}">
      <label>Units</label><select id="ju"><option value="mm">mm</option><option value="m">m</option><option value="in">in</option></select>
      <label>Tolerance (±, job units)</label><input type="number" id="jt" step="0.1" value="${job.tolerance}"></div></section>`);
    ($("#ju", hdr) as HTMLSelectElement).value = job.units;
    hdr.addEventListener("change", () => { job.name = ($("#jn", hdr) as HTMLInputElement).value; job.client = ($("#jc", hdr) as HTMLInputElement).value; job.site = ($("#js", hdr) as HTMLInputElement).value; job.surveyor = ($("#jv", hdr) as HTMLInputElement).value; job.units = ($("#ju", hdr) as HTMLSelectElement).value as Job["units"]; job.tolerance = +($("#jt", hdr) as HTMLInputElement).value; show("job"); });
    const pts = el(`<section class="panel"><h2>Points <span class="hint">${job.points.length} in job · ${selected.size} selected</span></h2>
      <div class="actions"><button class="btn" id="pAdd">Add point</button><button class="btn" id="pDel">Delete selected</button><button class="btn" id="pRen">Rename selected</button><button class="btn" id="pSelAll">Select all</button><button class="btn" id="pSelNone">Clear selection</button></div>
      <textarea id="paste" placeholder="Paste points here: Name  E  N  H  (tab, comma or space separated). Then press Add pasted."></textarea>
      <div class="actions"><button class="btn primary" id="pPaste">Add pasted</button></div></section>`);
    const tbl = pointTable(job.points, { selectable: true }); pts.append(tbl);
    onSelChange = () => { $(".hint", pts).textContent = `${job.points.length} in job · ${selected.size} selected`; };
    $("#pPaste", pts).onclick = () => { try { const r = importAny(($("#paste", pts) as HTMLTextAreaElement).value, "paste.csv"); r.points.forEach(p => { p.p = p.p.map(v => fromUnits(v, job.units)) as Vec3; p.source = "manual"; }); upsertPoints(job, r.points); show("job"); } catch (e: any) { alert(e.message); } };
    $("#pAdd", pts).onclick = () => { const n = window.prompt("Point name"); if (!n) return; const v = window.prompt(`E N H in ${job.units}`, "0 0 0")?.split(/[\s,]+/).map(Number); if (!v || v.length < 3) return; upsertPoints(job, [{ name: n, p: v.slice(0, 3).map(x => fromUnits(x, job.units)) as Vec3, source: "manual" }]); show("job"); };
    $("#pDel", pts).onclick = () => { if (!selected.size) return; job.points = job.points.filter(p => !selected.has(p.name)); selected.clear(); show("job"); };
    $("#pRen", pts).onclick = () => { if (selected.size !== 1) return alert("Select exactly one point"); const old = [...selected][0], n = window.prompt("New name", old); if (!n) return; job.points.find(p => p.name === old)!.name = n; selected = new Set([n]); show("job"); };
    $("#pSelAll", pts).onclick = () => { job.points.forEach(p => selected.add(p.name)); show("job"); }; $("#pSelNone", pts).onclick = () => { selected.clear(); show("job"); };
    const fits = el(`<section class="panel"><h2>Saved fits <span class="hint">${job.fits.length}</span></h2>${job.fits.length ? `<div class="tbl">${tableHTML(["Fit", "Type", "Created", ""], job.fits.map(ft => [ft.title, ft.kind, ft.created.slice(0, 16).replace("T", " "), `<button class="btn" data-del="${ft.id}">Remove</button>`]))}</div>` : `<div class="note">No fits saved yet. Each fit screen has a "Save to job" button; saved fits appear in the job report and DXF.</div>`}</section>`);
    fits.querySelectorAll<HTMLButtonElement>("[data-del]").forEach(b => (b.onclick = () => { job.fits = job.fits.filter(x => x.id !== b.dataset.del); show("job"); }));
    w.append(hdr, pts, fits);
  },

  instrument(w) {
    const box = el(`<div class="row"><section class="panel"><h2>Connection <span class="hint">Leica GeoCOM over RS232 / Bluetooth COM port</span></h2>
      <div class="kv"><label>Port</label><div style="display:flex;gap:6px"><select id="port" style="flex:1"><option value="sim">Simulator (no instrument)</option></select><button class="btn" id="refresh">Refresh</button></div>
      <label>Baud</label><select id="baud"><option>115200</option><option>57600</option><option>38400</option><option>19200</option><option>9600</option></select>
      <label>Measure program</label><select id="prg"><option value="${BAP_PRG.SINGLE_REF_STANDARD}">Prism — standard</option><option value="${BAP_PRG.SINGLE_REF_FAST}">Prism — fast</option><option value="${BAP_PRG.SINGLE_RLESS_VISIBLE}">Reflectorless</option><option value="${BAP_PRG.AVG_REF_STANDARD}">Prism — averaged</option></select></div>
      <div class="actions"><button class="btn primary" id="connect">${client ? "Disconnect" : "Connect"}</button><button class="btn" id="atrOn">ATR on</button><button class="btn" id="atrOff">ATR off</button><button class="btn" id="laser">Laser pointer</button></div>
      <div class="note">On the instrument set the interface to GeoCOM (Captivate: Settings → Connections → GeoCOM, matching baud). Measuring works without a robotic licence; turning, ATR and PowerSearch need the GeoCOM Robotic licence on the instrument.</div>
      <div class="err" id="ierr" hidden></div></section>
      <section class="panel"><h2>Station setup</h2><div class="kv">
        <label>Station point</label><select id="stPt"><option value="">— type coords —</option>${job.points.map(p => `<option value="${p.name}">${p.name}</option>`).join("")}</select>
        <label>E0 N0 H0 (${job.units})</label><input type="text" id="stXYZ" placeholder="0 0 0" style="width:100%">
        <label>Instrument height hi</label><input type="number" id="hi" step="0.001" value="0">
        <label>Reflector height hr</label><input type="number" id="hr" step="0.001" value="0">
        <label>Orientation Hz°</label><input type="number" id="ori" step="0.0001" placeholder="leave blank to keep"></div>
      <div class="actions"><button class="btn" id="setStation">Send station to instrument</button><button class="btn" id="resect">Resection from job points…</button></div>
      <div class="note">Resection: aim and measure 3+ known job points; DC Bench solves the station by 3D best-fit of measured polars to known coordinates and sends it to the instrument.</div></section></div>`);
    const meas = el(`<section class="panel"><h2>Measure</h2>
      <div class="kv"><label>Next point name</label><input type="text" id="nextName" value="${nextName()}"><label>Code</label><input type="text" id="code"></div>
      <div class="actions"><button class="btn primary" id="measure" ${client ? "" : "disabled"}>Measure &amp; store</button><button class="btn" id="angles" ${client ? "" : "disabled"}>Read angles</button><button class="btn" id="turnTo" ${client ? "" : "disabled"}>Turn to point…</button></div>
      <div class="stat" id="last"></div></section>`);
    w.append(box, meas);
    const err = (m: string) => { const e = $("#ierr", box); e.hidden = !m; e.textContent = m; };
    const refreshPorts = async () => { try { const { listSerialPorts } = await import("./core/serial"); const ports = await listSerialPorts(); const s = $("#port", box) as HTMLSelectElement; s.innerHTML = `<option value="sim">Simulator (no instrument)</option>` + ports.map(p => `<option value="${p.path}">${p.label}</option>`).join(""); } catch { /* not in Tauri */ } };
    refreshPorts(); $("#refresh", box).onclick = refreshPorts;
    $("#connect", box).onclick = async () => {
      if (client) { await client.close(); client = null; instrumentLabel = "Not connected"; show("instrument"); return; }
      const path = ($("#port", box) as HTMLSelectElement).value, baud = +($("#baud", box) as HTMLSelectElement).value;
      try {
        let tr: Transport;
        if (path === "sim") tr = new SimulatedInstrument(); else { const { SerialTransport } = await import("./core/serial"); tr = await SerialTransport.open(path, baud); }
        const c = new GeoComClient(tr);
        if (!(await c.ping())) throw new Error("Instrument did not answer. Check GeoCOM mode, cable/pairing and baud rate.");
        const name = await c.instrumentName(); const sn = await c.serialNumber();
        await c.setMeasureProgram(+($("#prg", box) as HTMLSelectElement).value);
        client = c; instrumentLabel = `${name} #${sn} on ${path}`; job.instrument = { name, serial: sn }; show("instrument");
      } catch (e: any) { err(e.message); }
    };
    $("#atrOn", box).onclick = () => client?.setAtr(true).then(() => toast("ATR on")).catch(e => err(e.message));
    $("#atrOff", box).onclick = () => client?.setAtr(false).then(() => toast("ATR off")).catch(e => err(e.message));
    $("#laser", box).onclick = () => client?.laserPointer(true).catch(e => err(e.message));
    ($("#stPt", box) as HTMLSelectElement).onchange = (e) => { const p = job.points.find(x => x.name === (e.target as HTMLSelectElement).value); if (p) ($("#stXYZ", box) as HTMLInputElement).value = p.p.map(v => f(v, 4)).join(" "); };
    $("#setStation", box).onclick = async () => {
      if (!client) return err("Connect first");
      const v = ($("#stXYZ", box) as HTMLInputElement).value.split(/[\s,]+/).map(Number); if (v.length < 3 || v.some(isNaN)) return err("Enter E0 N0 H0");
      try {
        await client.setStation(fromUnits(v[0], job.units), fromUnits(v[1], job.units), fromUnits(v[2], job.units), +($("#hi", box) as HTMLInputElement).value);
        await client.setReflectorHeight(+($("#hr", box) as HTMLInputElement).value);
        const ori = ($("#ori", box) as HTMLInputElement).value; if (ori !== "") await client.setOrientation(+ori);
        toast("Station sent"); err("");
      } catch (e: any) { err(e.message); }
    };
    $("#resect", box).onclick = () => resectionDialog(err);
    const renderLast = () => { if (!lastMeasure) return; $("#last", meas).innerHTML = [["Hz", fa(lastMeasure.hz)], ["V", fa(lastMeasure.v)], ["SD", f(lastMeasure.sd) + " " + job.units], ["E", lastMeasure.E !== undefined ? f(lastMeasure.E) : "—"], ["N", lastMeasure.N !== undefined ? f(lastMeasure.N) : "—"], ["H", lastMeasure.H !== undefined ? f(lastMeasure.H) : "—"]].map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join(""); };
    renderLast();
    $("#measure", meas).onclick = async () => {
      if (!client) return; try {
        const m = await client.measure(); lastMeasure = m; renderLast();
        if (m.E === undefined) return err("Measured, but the instrument returned no coordinates — set the station first.");
        const name = ($("#nextName", meas) as HTMLInputElement).value || nextName();
        upsertPoints(job, [{ name, p: [m.E!, m.N!, m.H!], code: ($("#code", meas) as HTMLInputElement).value || undefined, source: "instrument", raw: { hz: m.hz, v: m.v, sd: m.sd } }], "rename");
        ($("#nextName", meas) as HTMLInputElement).value = nextName(); refreshStatus(); toast(`Stored ${name}`); err("");
      } catch (e: any) { err(e.message); }
    };
    $("#angles", meas).onclick = async () => { if (!client) return; try { const a = await client.angles(); lastMeasure = { hz: a.hz, v: a.v, sd: 0, timestamp: "" }; renderLast(); } catch (e: any) { err(e.message); } };
    $("#turnTo", meas).onclick = async () => { if (!client) return; const n = window.prompt("Turn to job point (name) — needs robotic licence"); const p = job.points.find(x => x.name === n); if (!p) return; try { const st = await client.getStation(); const d: Vec3 = [p.p[0] - st.E, p.p[1] - st.N, p.p[2] - st.H - st.hi]; const hz = (Math.atan2(d[0], d[1]) * 180 / Math.PI + 360) % 360, v = Math.acos(d[2] / Math.hypot(...d)) * 180 / Math.PI; await client.turnTo(hz, v, true); toast(`Turned to ${n}`); } catch (e: any) { err(e.message); } };
  },

  bestfit(w) {
    const des = pointPicker("Design / control points"), mea = pointPicker("Measured points (matched by name; use suffix mapping below if names differ)");
    const opts = el(`<section class="panel"><div class="opts"><label><input type="checkbox" id="twoD"> 2D (ignore heights)</label><label><input type="checkbox" id="scale"> Solve scale</label><label>Measured suffix <input type="text" id="suffix" placeholder="e.g. _M" style="width:80px"></label></div>
      <div class="actions"><button class="btn primary" id="run">Compute</button><button class="btn" id="apply" disabled>Apply transform to measured points</button></div><div class="err" hidden></div></section>`);
    const out = resultPanel("Best-fit result"); w.append(el(`<div class="row"></div>`), opts, out.el); (w.firstElementChild as HTMLElement).append(des.el, mea.el);
    let last: ReturnType<typeof bestFit> | null = null, lastNames: string[] = [];
    $("#run", opts).onclick = () => {
      try {
        const twoD = ($("#twoD", opts) as HTMLInputElement).checked, scale = ($("#scale", opts) as HTMLInputElement).checked, suf = ($("#suffix", opts) as HTMLInputElement).value;
        const D = pointsByName(des.names()), M = pointsByName(mea.names()); const mm = new Map(M.map(p => [p.name.replace(new RegExp(suf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), ""), p]));
        const pairs = D.filter(d => mm.has(d.name)).map(d => ({ name: d.name, a: d.p, b: mm.get(d.name)!.p, mname: mm.get(d.name)!.name }));
        if (pairs.length < 3) throw new Error(`Only ${pairs.length} matched names — need 3 or more (same names in both lists, or set the suffix).`);
        const A = pairs.map(p => (twoD ? [p.a[0], p.a[1], 0] : p.a) as Vec3), B = pairs.map(p => (twoD ? [p.b[0], p.b[1], 0] : p.b) as Vec3);
        const r = bestFit(A, B, { scale }); last = r; lastNames = pairs.map(p => p.mname);
        const rows = pairs.map((p, i) => [p.name, f(r.residuals[i][0]), f(r.residuals[i][1]), ...(twoD ? [] : [f(r.residuals[i][2])]), f(r.magnitudes[i]), pill(flagOf(r.magnitudes[i]))]);
        out.stats([["Points", pairs.length], ["RMS", f(r.rms)], ["Max", f(r.max)], ["Rot Z", fa(r.rotXYZ[2])], ...(twoD ? [] : [["Rot X", fa(r.rotXYZ[0])] as [string, string], ["Rot Y", fa(r.rotXYZ[1])] as [string, string]]), ["Scale", r.s.toFixed(7)]]);
        out.table(tableHTML(["Point", "dE", "dN", ...(twoD ? [] : ["dH"]), "|d|", ""], rows));
        const rep = [stamp(), `${twoD ? "2D" : "3D"} best-fit ${scale ? "with" : "without"} scale (least squares, Horn quaternion)`, "", "Transform  measured ≈ s·R·design + t",
          `  t  ${r.t.map(v => f(v).padStart(12)).join("")}`, `  rot X/Y/Z  ${r.rotXYZ.map(fa).join("  ")}`, `  s  ${r.s.toFixed(7)}`, "  R  " + r.R.map(row => "[" + row.map(v => v.toFixed(7)).join(" ") + "]").join("\n     "), "",
          "Residuals (measured − fitted design)", ...rows.map(rw => "  " + rw[0].padEnd(10) + rw.slice(1, -1).map(c => c.padStart(10)).join("") + (rw[rw.length - 1].includes("bad") ? "  OUT" : "")), "",
          `RMS ${f(r.rms)}  max ${f(r.max)}  ${r.magnitudes.filter(m => flagOf(m) === "bad").length} point(s) outside ±${job.tolerance} ${job.units}`].join("\n");
        out.report(rep); out.error(""); out.plot({ pts: A, names: pairs.map(p => p.name), residuals: r.residuals, tol: job.tolerance, unitFactor: unitF() });
        ($("#apply", opts) as HTMLButtonElement).disabled = false;
        $(".sv", out.el).onclick = () => saveFit(twoD ? "bestfit2d" : "bestfit3d", `${twoD ? "2D" : "3D"} best-fit (${pairs.length} pts)`, { design: des.names(), measured: mea.names(), scale, twoD }, { R: r.R, t: r.t, s: r.s, rms: r.rms, max: r.max, rotXYZ: r.rotXYZ, residuals: r.residuals }, rep);
      } catch (e: any) { out.error(e.message); }
    };
    $("#apply", opts).onclick = () => {
      if (!last) return; if (!window.confirm("Transform the measured points INTO the design frame (inverse of the fit) and overwrite them in the job?")) return;
      // inverse: design ≈ (1/s)·Rᵀ·(measured − t)
      const Rt: Mat3 = [[last.R[0][0], last.R[1][0], last.R[2][0]], [last.R[0][1], last.R[1][1], last.R[2][1]], [last.R[0][2], last.R[1][2], last.R[2][2]]];
      const tInv: Vec3 = [-(Rt[0][0] * last.t[0] + Rt[0][1] * last.t[1] + Rt[0][2] * last.t[2]) / last.s, -(Rt[1][0] * last.t[0] + Rt[1][1] * last.t[1] + Rt[1][2] * last.t[2]) / last.s, -(Rt[2][0] * last.t[0] + Rt[2][1] * last.t[1] + Rt[2][2] * last.t[2]) / last.s];
      applyTransformToJob(job, Rt, tInv, 1 / last.s, lastNames); toast("Measured points transformed"); refreshStatus();
    };
  },

  plane(w) {
    const pk = pointPicker("Surface points"); const opts = el(`<section class="panel"><div class="actions"><button class="btn primary" id="run">Compute</button><button class="btn" id="lvl" disabled>Level job to this plane</button></div></section>`);
    const out = resultPanel("Plane fit result"); w.append(pk.el, opts, out.el);
    $("#run", opts).onclick = () => {
      try {
        const P = pointsByName(pk.names()); const r = planeFit(P.map(p => p.p));
        const rows = P.map((p, i) => [p.name, f(p.p[0]), f(p.p[1]), f(p.p[2]), f(r.residuals[i]), pill(flagOf(r.residuals[i]))]);
        out.stats([["Points", P.length], ["Flatness RMS", f(r.rms)], ["Max |offset|", f(Math.max(...r.residuals.map(Math.abs)))], ["Range", f(Math.max(...r.residuals) - Math.min(...r.residuals))], ["Pitch (about Y)", fa(r.pitchDeg)], ["Roll (about X)", fa(r.rollDeg)], ["Tilt from vertical", fa(r.tiltDeg)]]);
        out.table(tableHTML(["Point", "E", "N", "H", "Offset", ""], rows));
        const rep = [stamp(), "Plane fit (orthogonal least squares)", "", `Normal    ${r.n.map(v => v.toFixed(7)).join("  ")}`, `Centroid  ${r.c.map(v => f(v)).join("  ")}`, `Pitch ${fa(r.pitchDeg)}  Roll ${fa(r.rollDeg)}  Tilt ${fa(r.tiltDeg)}`, "", "Offsets from plane (+ along normal)", ...rows.map(rw => "  " + rw[0].padEnd(10) + rw[4].padStart(10) + (rw[5].includes("bad") ? "  OUT" : "")), "", `Flatness RMS ${f(r.rms)}  range ${f(Math.max(...r.residuals) - Math.min(...r.residuals))} ${job.units}`].join("\n");
        out.report(rep); out.error(""); out.plot({ pts: P.map(p => p.p), names: P.map(p => p.name), residuals: r.residuals, tol: job.tolerance, unitFactor: unitF() });
        ($("#lvl", opts) as HTMLButtonElement).disabled = false;
        $("#lvl", opts).onclick = () => { if (!window.confirm("Rotate ALL job points so this plane becomes level (normal → +Z), about the plane centroid?")) return; const R = levelTo(r.n); const c = r.c; applyTransformToJob(job, R, [c[0] - (R[0][0] * c[0] + R[0][1] * c[1] + R[0][2] * c[2]), c[1] - (R[1][0] * c[0] + R[1][1] * c[1] + R[1][2] * c[2]), c[2] - (R[2][0] * c[0] + R[2][1] * c[1] + R[2][2] * c[2])]); toast("Job levelled"); };
        $(".sv", out.el).onclick = () => saveFit("plane", `Plane (${P.length} pts)`, { points: pk.names() }, { n: r.n, c: r.c, rms: r.rms, pitchDeg: r.pitchDeg, rollDeg: r.rollDeg, residuals: r.residuals }, rep);
      } catch (e: any) { out.error(e.message); }
    };
  },

  circle(w) {
    const pk = pointPicker("Points on the circumference (bore, flange face edge, pedestal)");
    const opts = el(`<section class="panel"><div class="opts"><label><input type="checkbox" id="fixR"> Fixed radius</label><label>R (${job.units}) <input type="number" id="R" step="0.01" value="100"></label><label>Add centre as point named <input type="text" id="cname" placeholder="C1" style="width:90px"></label></div><div class="actions"><button class="btn primary" id="run">Compute</button><button class="btn" id="addc" disabled>Add centre point to job</button></div></section>`);
    const out = resultPanel("Circle fit result"); w.append(pk.el, opts, out.el);
    $("#run", opts).onclick = () => {
      try {
        const P = pointsByName(pk.names()); const fixR = ($("#fixR", opts) as HTMLInputElement).checked ? fromUnits(+($("#R", opts) as HTMLInputElement).value, job.units) : undefined;
        const r = circleFit3D(P.map(p => p.p), fixR);
        const rows = P.map((p, i) => [p.name, f(r.residuals[i]), f(r.planeResiduals[i]), r.angles[i].toFixed(3), pill(flagOf(r.residuals[i]))]);
        out.stats([["Points", P.length], ["Diameter", f(2 * r.r)], ["Radius", f(r.r)], ["Radial RMS", f(r.rms)], ["Out-of-plane RMS", f(Math.sqrt(r.planeResiduals.reduce((s, v) => s + v * v, 0) / P.length))], ["Centre E", f(r.center[0])], ["Centre N", f(r.center[1])], ["Centre H", f(r.center[2])]]);
        out.table(tableHTML(["Point", "Radial dev", "Out-of-plane", "Angle °", ""], rows));
        const rep = [stamp(), `Circle fit in 3D (plane + ${fixR ? "fixed-radius " : ""}geometric LSQ circle)`, "", `Centre   ${r.center.map(v => f(v)).join("  ")}`, `Radius   ${f(r.r)}   Diameter ${f(2 * r.r)}${fixR ? " (fixed)" : ""}`, `Normal   ${r.n.map(v => v.toFixed(7)).join("  ")}`, "", "Point      radial  out-of-plane   angle", ...rows.map(rw => "  " + rw[0].padEnd(10) + rw[1].padStart(9) + rw[2].padStart(12) + rw[3].padStart(10) + (rw[4].includes("bad") ? "  OUT" : "")), "", `Radial RMS ${f(r.rms)} ${job.units}`].join("\n");
        out.report(rep); out.error(""); out.plot({ pts: P.map(p => p.p), names: P.map(p => p.name), residuals: r.residuals, circle: { center: r.center, r: r.r, u: r.u, v: r.v }, tol: job.tolerance, unitFactor: unitF() });
        ($("#addc", opts) as HTMLButtonElement).disabled = false;
        $("#addc", opts).onclick = () => { const n = ($("#cname", opts) as HTMLInputElement).value || "C" + (job.points.filter(p => p.name.startsWith("C")).length + 1); upsertPoints(job, [{ name: n, p: r.center, source: "fit", code: "CIRCLE CENTRE" }], "rename"); toast(`Added ${n}`); refreshStatus(); };
        $(".sv", out.el).onclick = () => saveFit("circle", `Circle Ø${f(2 * r.r)} (${P.length} pts)`, { points: pk.names(), fixR }, { center: r.center, r: r.r, n: r.n, rms: r.rms, residuals: r.residuals }, rep);
      } catch (e: any) { out.error(e.message); }
    };
  },

  line(w) {
    const pk = pointPicker("Points along the line / pipe axis"); const opts = el(`<section class="panel"><div class="actions"><button class="btn primary" id="run">Compute</button></div></section>`);
    const out = resultPanel("Line fit result"); w.append(pk.el, opts, out.el);
    $("#run", opts).onclick = () => { try { const P = pointsByName(pk.names()); const r = lineFit(P.map(p => p.p)); const bearing = (Math.atan2(r.dir[0], r.dir[1]) * 180 / Math.PI + 360) % 360, slope = Math.asin(r.dir[2]) * 180 / Math.PI;
      out.stats([["Points", P.length], ["Straightness RMS", f(r.rms)], ["Max", f(Math.max(...r.residuals))], ["Bearing", fa(bearing)], ["Slope", fa(slope)]]);
      out.table(tableHTML(["Point", "Offset from line", ""], P.map((p, i) => [p.name, f(r.residuals[i]), pill(flagOf(r.residuals[i]))])));
      const rep = [stamp(), "Line fit (principal axis)", "", `Through  ${r.c.map(v => f(v)).join("  ")}`, `Direction ${r.dir.map(v => v.toFixed(7)).join("  ")}  bearing ${fa(bearing)}  slope ${fa(slope)}`, "", ...P.map((p, i) => `  ${p.name.padEnd(10)}${f(r.residuals[i]).padStart(10)}`), "", `Straightness RMS ${f(r.rms)} ${job.units}`].join("\n");
      out.report(rep); out.error(""); out.plot({ pts: P.map(p => p.p), names: P.map(p => p.name), residuals: r.residuals, tol: job.tolerance, unitFactor: unitF() });
      $(".sv", out.el).onclick = () => saveFit("line", `Line (${P.length} pts)`, { points: pk.names() }, { c: r.c, dir: r.dir, rms: r.rms }, rep);
    } catch (e: any) { out.error(e.message); } };
  },

  corner(w) {
    const a = pointPicker("Plane 1 points"), b = pointPicker("Plane 2 points"), c = pointPicker("Plane 3 points");
    const opts = el(`<section class="panel"><div class="opts"><label>Corner point name <input type="text" id="cn" value="CNR1" style="width:90px"></label></div><div class="actions"><button class="btn primary" id="run">Compute</button><button class="btn" id="add" disabled>Add corner point to job</button></div></section>`);
    const out = resultPanel("Corner fit result"); const row = el(`<div class="row"></div>`); row.append(a.el, b.el, c.el); w.append(row, opts, out.el);
    $("#run", opts).onclick = () => { try { const r = cornerFit(pointsByName(a.names()).map(p => p.p), pointsByName(b.names()).map(p => p.p), pointsByName(c.names()).map(p => p.p));
      out.stats([["Corner E", f(r.point[0])], ["Corner N", f(r.point[1])], ["Corner H", f(r.point[2])], ["Plane 1 RMS", f(r.planes[0].rms)], ["Plane 2 RMS", f(r.planes[1].rms)], ["Plane 3 RMS", f(r.planes[2].rms)]]);
      out.table(""); const rep = [stamp(), "Corner fit (intersection of three LSQ planes)", "", `Corner  ${r.point.map(v => f(v)).join("  ")}`, ...r.planes.map((p, i) => `Plane ${i + 1}: normal ${p.n.map(v => v.toFixed(6)).join(" ")}  flatness RMS ${f(p.rms)}`)].join("\n");
      out.report(rep); out.error(""); ($("#add", opts) as HTMLButtonElement).disabled = false;
      $("#add", opts).onclick = () => { upsertPoints(job, [{ name: ($("#cn", opts) as HTMLInputElement).value, p: r.point, source: "fit", code: "CORNER" }], "rename"); toast("Corner added"); refreshStatus(); };
      $(".sv", out.el).onclick = () => saveFit("corner", "Corner", { p1: a.names(), p2: b.names(), p3: c.names() }, { point: r.point }, rep);
    } catch (e: any) { out.error(e.message); } };
  },

  flange(w) {
    const holes = pointPicker("Bolt-hole centres (one per hole)"), face = pointPicker("Flange face points (optional, for flatness and face offset)");
    const opts = el(`<section class="panel"><div class="opts"><label>Holes <input type="number" id="n" value="8" min="3" step="1" style="width:64px"></label><label>Nominal PCD (${job.units}) <input type="number" id="pcd" step="0.1" value="203.2"></label><label>Design axis <select id="axis"><option value="x">X / E</option><option value="y">Y / N</option><option value="z" selected>Z / up</option></select></label><label>Centre point name <input type="text" id="cn" value="FL1" style="width:80px"></label></div>
      <div class="actions"><button class="btn primary" id="run">Compute</button><button class="btn" id="add" disabled>Add flange centre to job</button></div></section>`);
    const out = resultPanel("Flange result"); const row = el(`<div class="row"></div>`); row.append(holes.el, face.el); w.append(row, opts, out.el);
    $("#run", opts).onclick = () => { try {
      const H = pointsByName(holes.names()), F = pointsByName(face.names()); const nH = +($("#n", opts) as HTMLInputElement).value, pcd = fromUnits(+($("#pcd", opts) as HTMLInputElement).value, job.units), axis = ($("#axis", opts) as HTMLSelectElement).value as "x" | "y" | "z";
      const r = flangeFit(H.map(p => p.p), { nHoles: nH, nominalPCD: pcd, axis, facePoints: F.length >= 3 ? F.map(p => p.p) : undefined });
      const rows = H.map((p, i) => [p.name, f(r.circle.residuals[i]), f(r.circle.planeResiduals[i]), r.holeAngles[i].toFixed(3), pill(flagOf(r.circle.residuals[i]))]);
      out.stats([["PCD measured", f(r.pcd)], ["PCD error", f(r.pcdError)], ["Face angle to axis", fa(r.faceAngleDeg)], ["Pitch", fa(r.pitchDeg)], ["Roll", fa(r.rollDeg)], ["Hole spacing err", fa(r.maxSpacingErrorDeg)], ["Radial RMS", f(r.circle.rms)], ...(r.face ? [["Face flatness RMS", f(r.face.rms)] as [string, string], ["Holes→face offset", f(r.faceToHolesGapMm!)] as [string, string]] : [])]);
      out.table(tableHTML(["Hole", "Radial dev", "Out-of-plane", "Angle °", ""], rows));
      const rep = [stamp(), `Flange: ${nH} holes, nominal PCD ${f(pcd)}`, "", `Centre      ${r.circle.center.map(v => f(v)).join("  ")}`, `PCD         ${f(r.pcd)}  (error ${r.pcdError >= 0 ? "+" : ""}${f(r.pcdError)})`, `Normal      ${r.circle.n.map(v => v.toFixed(7)).join("  ")}`, `Face angle to ${axis.toUpperCase()} axis ${fa(r.faceAngleDeg)}   pitch ${fa(r.pitchDeg)}   roll ${fa(r.rollDeg)}`, `Hole spacing nominal ${r.nominalSpacingDeg.toFixed(3)}°, max deviation ${fa(r.maxSpacingErrorDeg)}`, ...(r.face ? [`Face flatness RMS ${f(r.face.rms)}  holes-to-face offset ${f(r.faceToHolesGapMm!)}`] : []), "", "Hole      radial  out-of-plane   angle", ...rows.map(rw => "  " + rw[0].padEnd(10) + rw[1].padStart(9) + rw[2].padStart(12) + rw[3].padStart(10) + (rw[4].includes("bad") ? "  OUT" : ""))].join("\n");
      out.report(rep); out.error(""); out.plot({ pts: H.map(p => p.p), names: H.map(p => p.name), residuals: r.circle.residuals, circle: { center: r.circle.center, r: r.circle.r, u: r.circle.u, v: r.circle.v }, tol: job.tolerance, unitFactor: unitF() });
      ($("#add", opts) as HTMLButtonElement).disabled = false;
      $("#add", opts).onclick = () => { upsertPoints(job, [{ name: ($("#cn", opts) as HTMLInputElement).value, p: r.circle.center, source: "fit", code: "FLANGE CENTRE" }], "rename"); toast("Flange centre added"); refreshStatus(); };
      $(".sv", out.el).onclick = () => saveFit("flange", `Flange ${nH}×, PCD ${f(r.pcd)}`, { holes: holes.names(), face: face.names(), nH, pcd, axis }, { center: r.circle.center, n: r.circle.n, pcd: r.pcd, pcdError: r.pcdError, faceAngleDeg: r.faceAngleDeg, pitchDeg: r.pitchDeg, rollDeg: r.rollDeg, holeAngles: r.holeAngles }, rep);
    } catch (e: any) { out.error(e.message); } };
  },

  transform(w) {
    const pk = pointPicker("Points to transform (none selected = whole job)");
    const opts = el(`<section class="panel"><div class="opts"><label>dE <input type="number" id="tx" value="0" step="0.1"></label><label>dN <input type="number" id="ty" value="0" step="0.1"></label><label>dH <input type="number" id="tz" value="0" step="0.1"></label>
      <label>Rot X° <input type="number" id="rx" value="0" step="0.0001"></label><label>Rot Y° <input type="number" id="ry" value="0" step="0.0001"></label><label>Rot Z° <input type="number" id="rz" value="0" step="0.0001"></label><label>Scale <input type="number" id="s" value="1" step="0.000001"></label>
      <label>About <select id="about"><option value="centroid">centroid</option><option value="origin">origin</option><option value="point">a job point…</option></select></label><input type="text" id="aboutPt" placeholder="point name" style="width:100px"></div>
      <div class="actions"><button class="btn primary" id="preview">Preview</button><button class="btn" id="apply">Apply to job</button></div><div class="note">Values in ${job.units}; rotation applied as Rz·Ry·Rx about the pivot, then scale, then translation.</div></section>`);
    const out = resultPanel("Transform preview"); w.append(pk.el, opts, out.el);
    const params = () => { const v = (id: string) => +($(`#${id}`, opts) as HTMLInputElement).value; const names = pk.names().length ? pk.names() : job.points.map(p => p.name); const P = pointsByName(names); const ab = ($("#about", opts) as HTMLSelectElement).value; let pivot: Vec3 = [0, 0, 0]; if (ab === "centroid") pivot = centroid(P.map(p => p.p)); if (ab === "point") { const q = job.points.find(p => p.name === ($("#aboutPt", opts) as HTMLInputElement).value); if (!q) throw new Error("Pivot point not found"); pivot = q.p; } return { P, names, R: rotZYX(v("rx"), v("ry"), v("rz")), t: [fromUnits(v("tx"), job.units), fromUnits(v("ty"), job.units), fromUnits(v("tz"), job.units)] as Vec3, s: v("s"), pivot }; };
    $("#preview", opts).onclick = () => { try { const q = params(); const after = transformPoints(q.P.map(p => p.p), q); out.stats([["Points", q.P.length], ["Pivot", q.pivot.map(v => f(v, 1)).join(", ")]]); out.table(tableHTML(["Point", "E", "N", "H", "→ E", "→ N", "→ H"], q.P.map((p, i) => [p.name, f(p.p[0]), f(p.p[1]), f(p.p[2]), f(after[i][0]), f(after[i][1]), f(after[i][2])]))); out.report([stamp(), "Transform  out = s·R·(p − pivot) + pivot + t", `t ${q.t.map(v => f(v)).join("  ")}  rot ${eulerZYX(q.R).map(fa).join(" ")}  s ${q.s}  pivot ${q.pivot.map(v => f(v)).join("  ")}`, "", ...q.P.map((p, i) => `${p.name.padEnd(10)}${after[i].map(v => f(v).padStart(12)).join("")}`)].join("\n")); out.error(""); out.plot({ pts: q.P.map(p => p.p), names: q.P.map(p => p.name), after, tol: job.tolerance, unitFactor: unitF() }); } catch (e: any) { out.error(e.message); } };
    $("#apply", opts).onclick = () => { try { const q = params(); if (!window.confirm(`Transform ${q.P.length} point(s) in the job?`)) return; const tEff: Vec3 = [q.pivot[0] - q.s * (q.R[0][0] * q.pivot[0] + q.R[0][1] * q.pivot[1] + q.R[0][2] * q.pivot[2]) + q.t[0], q.pivot[1] - q.s * (q.R[1][0] * q.pivot[0] + q.R[1][1] * q.pivot[1] + q.R[1][2] * q.pivot[2]) + q.t[1], q.pivot[2] - q.s * (q.R[2][0] * q.pivot[0] + q.R[2][1] * q.pivot[1] + q.R[2][2] * q.pivot[2]) + q.t[2]]; applyTransformToJob(job, q.R, tEff, q.s, q.names); toast("Applied"); show("transform"); } catch (e: any) { out.error(e.message); } };
  },

  level(w) {
    const pk = pointPicker("Points defining the reference (a plane: 3+ points, or an axis: 2+ points)");
    const opts = el(`<section class="panel"><div class="opts"><label>Reference is a <select id="kind"><option value="plane">plane → make level (normal to +Z)</option><option value="axisZ">axis → make vertical (+Z)</option><option value="axisY">axis → align to +N (Y)</option><option value="axisX">axis → align to +E (X)</option></select></label></div><div class="actions"><button class="btn primary" id="run">Compute pitch &amp; roll</button><button class="btn" id="apply" disabled>Apply to whole job</button></div></section>`);
    const out = resultPanel("Pitch & roll"); w.append(pk.el, opts, out.el); let R: Mat3 | null = null, piv: Vec3 = [0, 0, 0];
    $("#run", opts).onclick = () => { try { const P = pointsByName(pk.names()).map(p => p.p); const kind = ($("#kind", opts) as HTMLSelectElement).value; let vec: Vec3, target: Vec3 = [0, 0, 1];
      if (kind === "plane") { const pl = planeFit(P); vec = pl.n; piv = pl.c; } else { const ln = lineFit(P); vec = ln.dir; piv = ln.c; if (vec[2] < 0 && kind === "axisZ") vec = [-vec[0], -vec[1], -vec[2]]; target = kind === "axisZ" ? [0, 0, 1] : kind === "axisY" ? [0, 1, 0] : [1, 0, 0]; if (kind !== "axisZ" && (vec[0] * target[0] + vec[1] * target[1]) < 0) vec = [-vec[0], -vec[1], -vec[2]]; }
      R = levelTo(vec, target); const e = eulerZYX(R);
      out.stats([["Rot X (roll)", fa(e[0])], ["Rot Y (pitch)", fa(e[1])], ["Rot Z", fa(e[2])], ["Pivot", piv.map(v => f(v, 1)).join(", ")]]); out.table("");
      out.report([stamp(), `Pitch & roll: rotate so the ${kind === "plane" ? "plane normal" : "axis"} ${vec.map(v => v.toFixed(6)).join(" ")} → ${target.join(" ")}`, `Rotation X/Y/Z ${e.map(fa).join("  ")} about pivot ${piv.map(v => f(v)).join("  ")}`, "R " + R.map(row => "[" + row.map(v => v.toFixed(7)).join(" ") + "]").join("\n  ")].join("\n")); out.error(""); ($("#apply", opts) as HTMLButtonElement).disabled = false;
    } catch (e: any) { out.error(e.message); } };
    $("#apply", opts).onclick = () => { if (!R || !window.confirm("Rotate every point in the job?")) return; const c = piv; applyTransformToJob(job, R, [c[0] - (R[0][0] * c[0] + R[0][1] * c[1] + R[0][2] * c[2]), c[1] - (R[1][0] * c[0] + R[1][1] * c[1] + R[1][2] * c[2]), c[2] - (R[2][0] * c[0] + R[2][1] * c[1] + R[2][2] * c[2])]); toast("Job rotated"); show("level"); };
  },

  cad(w) {
    const box = el(`<section class="panel"><h2>Plot to CAD <span class="hint">DXF R12 — opens in AutoCAD, BricsCAD, MicroStation, Navisworks</span></h2>
      <div class="opts"><label><input type="checkbox" id="pts" checked> Points with labels</label><label><input type="checkbox" id="fits" checked> Saved fits (circles, plane centroids, normals)</label><label><input type="checkbox" id="res" checked> Residual vectors (×<input type="number" id="ex" value="100" style="width:70px">)</label><label>Units in file <select id="u"><option value="m">metres</option><option value="mm">millimetres</option></select></label><label>Marker size <input type="number" id="ms" value="0.02" step="0.005"></label></div>
      <div class="actions"><button class="btn primary" id="go">Write DXF…</button></div>
      <div class="note">Layers: POINTS, LABELS, FIT_CIRCLE, FIT_PLANE, FIT_LINE, RESIDUALS. Point marks are 3D crosses so they survive in Navisworks.</div></section>`);
    w.append(box);
    $("#go", box).onclick = async () => {
      const mm = ($("#u", box) as HTMLSelectElement).value === "mm", k = mm ? 1000 : 1, S = (p: Vec3): Vec3 => [p[0] * k, p[1] * k, p[2] * k], ms = +($("#ms", box) as HTMLInputElement).value * k, ex = +($("#ex", box) as HTMLInputElement).value;
      const d = new DxfWriter().layer("POINTS", 7).layer("LABELS", 8).layer("FIT_CIRCLE", 1).layer("FIT_PLANE", 3).layer("FIT_LINE", 5).layer("RESIDUALS", 2);
      if (($("#pts", box) as HTMLInputElement).checked) for (const p of job.points) d.labelledPoint(S(p.p), p.name, ms, "POINTS");
      if (($("#fits", box) as HTMLInputElement).checked) for (const ft of job.fits) {
        const r = ft.result as any;
        if (ft.kind === "circle" || ft.kind === "flange") { d.circle(S(r.center), (r.r ?? r.pcd / 2) * k, r.n, "FIT_CIRCLE"); d.labelledPoint(S(r.center), ft.title, ms, "FIT_CIRCLE"); d.line(S(r.center), S([r.center[0] + r.n[0] * 0.2, r.center[1] + r.n[1] * 0.2, r.center[2] + r.n[2] * 0.2]), "FIT_CIRCLE"); }
        if (ft.kind === "plane") { const pts = pointsByName((ft.inputs as any).points as string[]); if (pts.length >= 3) { const c = S(r.c), n = r.n as Vec3; d.line(c, [c[0] + n[0] * 0.3 * k, c[1] + n[1] * 0.3 * k, c[2] + n[2] * 0.3 * k], "FIT_PLANE"); for (let i = 0; i < pts.length; i++) d.line(S(pts[i].p), S(pts[(i + 1) % pts.length].p), "FIT_PLANE"); } }
        if (ft.kind === "line") { const c = r.c as Vec3, v = r.dir as Vec3; d.line(S([c[0] - v[0], c[1] - v[1], c[2] - v[2]]), S([c[0] + v[0], c[1] + v[1], c[2] + v[2]]), "FIT_LINE"); }
        if (ft.kind === "corner") d.labelledPoint(S(r.point), ft.title, ms, "FIT_LINE");
        if ((ft.kind === "bestfit3d" || ft.kind === "bestfit2d") && ($("#res", box) as HTMLInputElement).checked) { const des = pointsByName((ft.inputs as any).design as string[]); (r.residuals as Vec3[]).forEach((rv, i) => { const p = des[i]; if (!p) return; const q = S(p.p); d.line(q, [q[0] + rv[0] * ex * k, q[1] + rv[1] * ex * k, q[2] + rv[2] * ex * k], "RESIDUALS"); }); }
      }
      const p = await saveTextFile(`${job.name}.dxf`, d.toString(), [{ name: "DXF", extensions: ["dxf"] }]); if (p) toast("DXF written");
    };
  },

  report(w) {
    const txt = [stamp(), `Client: ${job.client ?? ""}   Site: ${job.site ?? ""}   Surveyor: ${job.surveyor ?? ""}`, `Instrument: ${job.instrument?.name ?? "—"} ${job.instrument?.serial ? "#" + job.instrument.serial : ""}`, "", `POINTS (${job.points.length})`, "Name        E/X            N/Y            H/Z          Code", ...job.points.map(p => `${p.name.padEnd(12)}${f(p.p[0], 4).padStart(14)}${f(p.p[1], 4).padStart(14)}${f(p.p[2], 4).padStart(14)}  ${p.code ?? ""}`), "", `FITS (${job.fits.length})`, ...job.fits.flatMap(ft => ["", "═".repeat(70), ft.report]), "", "HISTORY", ...job.history.map(h => `${h.at.slice(0, 16).replace("T", " ")}  ${h.what}`)].join("\n");
    const box = el(`<section class="panel"><h2>Job report <span class="hint"><button class="btn cp">Copy</button> <button class="btn sv">Save .txt…</button> <button class="btn csv">Save points .csv…</button></span></h2><pre class="rep" style="max-height:none"></pre></section>`);
    $("pre", box).textContent = txt; $(".cp", box).onclick = () => navigator.clipboard.writeText(txt).then(() => toast("Copied")); $(".sv", box).onclick = () => saveTextFile(`${job.name}_report.txt`, txt, [{ name: "Text", extensions: ["txt"] }]); $(".csv", box).onclick = () => saveTextFile(`${job.name}.csv`, writeCSV(job.points), [{ name: "CSV", extensions: ["csv"] }]);
    w.append(box);
  },
};

function nextName() { const nums = job.points.map(p => parseInt(p.name.replace(/\D/g, ""), 10)).filter(n => !isNaN(n)); return String((nums.length ? Math.max(...nums) : 0) + 1); }

/** Resection: measure 3+ known points from an unknown station; solve station by best-fit. */
async function resectionDialog(err: (m: string) => void) {
  if (!client) return err("Connect first");
  const names = expandNames(window.prompt("Known job points to observe (e.g. TP1-TP4)") ?? ""); const known = pointsByName(names);
  if (known.length < 3) return err("Need 3 or more known points");
  const local: Vec3[] = [];
  for (const k of known) {
    if (!window.confirm(`Aim at ${k.name} and press OK to measure`)) return;
    try { const m = await client.measure(); const v = m.v * Math.PI / 180, hz = m.hz * Math.PI / 180, hd = m.sd * Math.sin(v); local.push([hd * Math.sin(hz), hd * Math.cos(hz), m.sd * Math.cos(v)]); } catch (e: any) { return err(e.message); }
  }
  // local frame → job frame: rotation about Z only + translation (instrument assumed levelled)
  const r = bestFit(local.map(p => [p[0], p[1], 0] as Vec3), known.map(k => [k.p[0], k.p[1], 0] as Vec3));
  const dz = known.reduce((s, k, i) => s + (k.p[2] - local[i][2]), 0) / known.length;
  const st: Vec3 = [r.t[0], r.t[1], dz];
  const ori = r.rotXYZ[2];
  if (!window.confirm(`Station solved: E ${f(st[0])}  N ${f(st[1])}  H ${f(st[2])} (incl. hi)   orientation +${fa(ori)}   RMS ${f(r.rms)} ${job.units}\nSend to instrument?`)) return;
  try { await client.setStation(st[0], st[1], st[2], 0); const a = await client.angles(); await client.setOrientation(((a.hz + ori) % 360 + 360) % 360); toast("Station set from resection"); } catch (e: any) { err(e.message); }
}

renderShell(); show("job");
