import { describe, it, expect } from "vitest";
import { rotZYX, matvec, add, scl, unit, cross, Vec3 } from "../geom";
import { bestFit, planeFit, circleFit3D, flangeFit, cornerFit, lineFit, levelTo } from "../fits";
import { parseGSI, writeGSI, parseCSV, writeCSV, parseJXL } from "../formats";
import { DxfWriter } from "../dxf";
import { GeoComClient, SimulatedInstrument, parseReply } from "../geocom";
import { newJob, serializeJob, parseJob, upsertPoints } from "../job";

const A: Vec3[] = [[1000, 2000, 100], [4500, 2050, 110], [4480, 5600, 95], [1020, 5580, 105], [2750, 3800, 1850], [2800, 2100, 900]];

describe("best-fit", () => {
  it("recovers a known rigid transform", () => {
    const R = rotZYX(0.35, -0.2, 12.5), t: Vec3 = [850.5, -220.3, 45.2];
    const B = A.map(p => add(matvec(R, p), t));
    const f = bestFit(A, B);
    expect(f.rotXYZ[0]).toBeCloseTo(0.35, 8); expect(f.rotXYZ[1]).toBeCloseTo(-0.2, 8); expect(f.rotXYZ[2]).toBeCloseTo(12.5, 8);
    expect(f.t[0]).toBeCloseTo(850.5, 6); expect(f.rms).toBeLessThan(1e-9); expect(f.s).toBe(1);
  });
  it("recovers scale when asked", () => {
    const R = rotZYX(0, 0, 30), B = A.map(p => add(scl(matvec(R, p), 1.0005), [1, 2, 3]));
    const f = bestFit(A, B, { scale: true });
    expect(f.s).toBeCloseTo(1.0005, 9);
  });
  it("rejects fewer than 3 points", () => { expect(() => bestFit(A.slice(0, 2), A.slice(0, 2))).toThrow(); });
});

describe("plane / circle / flange / corner / line", () => {
  it("plane fit returns tilt angles", () => {
    const P: Vec3[] = []; for (let x = 0; x <= 4; x++) for (let y = 0; y <= 3; y++) P.push([x, y, 0.01 * x - 0.02 * y + 5]);
    const r = planeFit(P);
    expect(r.rms).toBeLessThan(1e-12);
    expect(r.pitchDeg).toBeCloseTo(-Math.atan(0.01) * 180 / Math.PI, 8);
    expect(r.rollDeg).toBeCloseTo(Math.atan(0.02) * 180 / Math.PI, 8);
  });
  it("circle fit in 3D recovers centre and radius", () => {
    const c: Vec3 = [3120.4, 1540.2, 2015.8], r = 101.6, n = unit([0.012, -0.008, 1]), u = unit(cross(n, [1, 0, 0])), v = cross(n, u);
    const P: Vec3[] = []; for (let i = 0; i < 8; i++) { const a = (i + 0.5) * Math.PI / 4; P.push(add(add(c, scl(u, r * Math.cos(a))), scl(v, r * Math.sin(a)))); }
    const f = circleFit3D(P);
    expect(f.center[0]).toBeCloseTo(c[0], 8); expect(f.r).toBeCloseTo(r, 8); expect(f.rms).toBeLessThan(1e-9);
    const fixed = circleFit3D(P, 100); expect(fixed.r).toBe(100);
    const fl = flangeFit(P, { nHoles: 8, nominalPCD: 203.2, axis: "z" });
    expect(fl.pcdError).toBeCloseTo(0, 8); expect(fl.maxSpacingErrorDeg).toBeLessThan(1e-8); expect(fl.faceAngleDeg).toBeCloseTo(Math.acos(n[2]) * 180 / Math.PI, 8);
  });
  it("corner fit intersects three planes", () => {
    const px: Vec3[] = [[2, 0, 0], [2, 1, 0], [2, 0, 1], [2, 1, 1]], py: Vec3[] = [[0, 3, 0], [1, 3, 0], [0, 3, 1], [1, 3, 1]], pz: Vec3[] = [[0, 0, 4], [1, 0, 4], [0, 1, 4], [1, 1, 4]];
    const c = cornerFit(px, py, pz); expect(c.point[0]).toBeCloseTo(2, 9); expect(c.point[1]).toBeCloseTo(3, 9); expect(c.point[2]).toBeCloseTo(4, 9);
  });
  it("line fit and levelling", () => {
    const L = lineFit([[0, 0, 0], [1, 1, 0.5], [2, 2, 1], [3, 3, 1.5]]); expect(Math.abs(L.dir[0])).toBeCloseTo(Math.abs(L.dir[1]), 9); expect(L.rms).toBeLessThan(1e-12);
    const R = levelTo([0.1, 0, 1]); const up = matvec(R, unit([0.1, 0, 1])); expect(up[2]).toBeCloseTo(1, 9);
  });
});

describe("GSI", () => {
  it("parses GSI8 coordinate blocks", () => {
    const txt = "110001+00000001 81..00+01999507 82..00+00123456 83..00+00050123 \n110002+00000002 81..00-00000500 82..00+00000250 83..00+00000000 \n";
    const r = parseGSI(txt);
    expect(r.points.length).toBe(2);
    expect(r.points[0].name).toBe("1"); expect(r.points[0].p).toEqual([1999.507, 123.456, 50.123]);
    expect(r.points[1].p[0]).toBe(-0.5);
  });
  it("parses GSI16 with station and polar observations", () => {
    const st = "*110001+0000000000000ST1 84..10+0000000001000000 85..10+0000000002000000 86..10+0000000000100000 88..10+0000000000001550 \n";
    const obs = "*110002+00000000000000P1 21.302+0000000000000000 22.303+0000000009000000 31..06+0000000000100000 87..16+0000000000000000 \n";
    const r = parseGSI(st + obs);
    expect(r.stations.length).toBe(1); expect(r.stations[0].hi).toBeCloseTo(1.55, 9);
    expect(r.points.length).toBe(1);
    // Hz 0°, V 90° (zenith), SD 10 m → dN = 10, dH = hi
    expect(r.points[0].p[1]).toBeCloseTo(2010, 6); expect(r.points[0].p[0]).toBeCloseTo(1000, 6); expect(r.points[0].p[2]).toBeCloseTo(101.55, 6);
  });
  it("round-trips through writeGSI", () => {
    const out = writeGSI([{ name: "A1", p: [1234.5678, -9.8765, 0.004] }], true);
    const back = parseGSI(out);
    expect(back.points[0].name).toBe("A1"); expect(back.points[0].p[0]).toBeCloseTo(1234.5678, 9); expect(back.points[0].p[1]).toBeCloseTo(-9.8765, 9);
  });
});

describe("CSV / JXL / DXF / job", () => {
  it("parses CSV with header and codes", () => {
    const r = parseCSV("Name,E,N,H,Code\nTP1,1000.1,2000.2,100.3,CTRL\nTP2 1001 2002 100 \n");
    expect(r.points.length).toBe(2); expect(r.points[0].code).toBe("CTRL"); expect(r.points[1].p).toEqual([1001, 2002, 100]);
    expect(writeCSV(r.points)).toContain("TP1,1000.1000,2000.2000,100.3000,CTRL");
  });
  it("parses JobXML points", () => {
    const xml = `<JOBFile><Reductions><Point><Name>101</Name><Code>FL</Code><Grid><North>2000.5</North><East>1000.25</East><Elevation>50</Elevation></Grid></Point></Reductions></JOBFile>`;
    const r = parseJXL(xml); expect(r.points[0].p).toEqual([1000.25, 2000.5, 50]); expect(r.points[0].code).toBe("FL");
  });
  it("writes a DXF with layers and entities", () => {
    const d = new DxfWriter().layer("FIT", 1).labelledPoint([1, 2, 3], "P1", 0.1, "FIT").circle([0, 0, 0], 5, [0, 0, 1], "FIT").toString();
    expect(d).toContain("AC1009"); expect(d).toContain("CIRCLE"); expect(d).toContain("\nP1\n"); expect(d.trim().endsWith("EOF")).toBe(true);
  });
  it("job save/load and merge", () => {
    const j = newJob("Test"); upsertPoints(j, [{ name: "A", p: [1, 2, 3] }]); upsertPoints(j, [{ name: "A", p: [9, 9, 9] }], "skip");
    const back = parseJob(serializeJob(j)); expect(back.points[0].p).toEqual([1, 2, 3]); expect(back.name).toBe("Test");
  });
});

describe("GeoCOM", () => {
  it("parses replies", () => {
    expect(parseReply("%R1P,0,3:0,1.5707,1.571,23.4")).toEqual({ comRc: 0, trId: 3, rc: 0, values: ["1.5707", "1.571", "23.4"] });
    expect(parseReply("garbage")).toBeNull();
  });
  it("talks to the simulator end to end", async () => {
    const sim = new SimulatedInstrument(); const c = new GeoComClient(sim, 1000);
    expect(await c.ping()).toBe(true);
    expect(await c.instrumentName()).toContain("TS16");
    await c.setStation(500, 600, 10, 1.6);
    const m = await c.measure({ waitMs: 100 });
    expect(m.hz).toBeCloseTo(45.1234, 6); expect(m.sd).toBeCloseTo(23.456, 9);
    expect(m.N).toBeCloseTo(600 + 23.456 * Math.sin(88.5 * Math.PI / 180) * Math.cos(45.1234 * Math.PI / 180), 6);
  });
});
