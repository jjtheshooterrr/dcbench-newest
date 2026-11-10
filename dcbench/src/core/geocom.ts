// Leica GeoCOM ASCII client. Protocol: request "%R1Q,<RPC>:<p1>,<p2>\r\n",
// reply "%R1P,<ComRC>,<TrId>:<RC>,<v1>,<v2>...\r\n". Works over RS232 or a
// Bluetooth SPP COM port. RPC numbers follow the Leica GeoCOM Reference
// Manual (TPS1200 / Viva / Captivate share the core set used here).
//
// Instrument-side notes:
//  - Set the instrument interface to GeoCOM (Captivate: Settings > Connections).
//  - Measure/read works without a robotic licence; motorised positioning,
//    ATR and PowerSearch need the GeoCOM Robotic licence on the instrument.

export interface Transport {
  write(data: string): Promise<void>;
  readLine(timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

export const RPC = {
  COM_NullProc: 0,
  COM_GetDoublePrecision: 108, COM_SetDoublePrecision: 107,
  CSV_GetInstrumentNo: 5003, CSV_GetInstrumentName: 5004, CSV_GetDateTime: 5008, CSV_GetIntTemp: 5011,
  CSV_CheckPower: 5039,
  TMC_GetStation: 2009, TMC_SetStation: 2010, TMC_GetHeight: 2011, TMC_SetHeight: 2012,
  TMC_DoMeasure: 2008, TMC_GetSimpleMea: 2108, TMC_GetCoordinate: 2082, TMC_GetAngle5: 2107,
  TMC_SetOrientation: 2113, TMC_GetAtmCorr: 2029, TMC_SetAtmCorr: 2028,
  BAP_SetMeasPrg: 17019, BAP_GetMeasPrg: 17018, BAP_MeasDistanceAngle: 17017,
  AUT_MakePositioning: 9037, AUT_Search: 9029, AUT_ChangeFace: 9028,
  AUS_GetUserAtrState: 18006, AUS_SetUserAtrState: 18005,
  AUS_GetUserLockState: 18008, AUS_SetUserLockState: 18007,
  EDM_Laserpointer: 1004,
} as const;

export const TMC_INCLINE = { MEA_INC: 0, AUTO_INC: 1, PLANE_INC: 2 } as const;
export const TMC_MEASURE = { STOP: 0, DEF_DIST: 1, CLEAR: 3, SIGNAL: 4, DO_MEASURE: 6, RTRK_DIST: 8, RED_TRK_DIST: 10, FREQUENCY: 11 } as const;
export const BAP_PRG = { SINGLE_REF_STANDARD: 0, SINGLE_REF_FAST: 1, SINGLE_REF_VISIBLE: 2, SINGLE_RLESS_VISIBLE: 3, CONT_REF_STANDARD: 4, CONT_RLESS_VISIBLE: 6, AVG_REF_STANDARD: 7, AVG_RLESS_VISIBLE: 9 } as const;

/** Common GeoCOM return codes. */
export const GRC: Record<number, string> = {
  0: "OK", 1: "Unknown error", 2: "Invalid parameter", 3: "Invalid result", 4: "Fatal error", 5: "Not implemented",
  6: "Time out", 7: "Unknown subsystem", 8: "Insufficient resources", 9: "Not licensed / not available",
  10: "Low memory", 11: "Not initialised", 13: "Shut down", 14: "Unknown syntax", 15: "Not implemented in this instrument",
  21: "Not ready", 22: "No reply", 23: "Not initialised", 29: "Subsystem down", 31: "Invalid value",
  1283: "EDM: measurement OK but not for this mode", 1284: "Angle: not level", 1285: "Angle: distance not valid",
  1288: "EDM: no signal", 1290: "EDM: distance timeout", 1292: "Target not found / no distance", 8710: "ATR not found",
  8711: "ATR: multiple targets", 8712: "Motorisation / positioning error", 8713: "ATR: target not visible",
};
export const rcText = (rc: number) => GRC[rc] ?? `GeoCOM RC ${rc}`;

export class GeoComError extends Error { constructor(public rc: number, msg?: string) { super(msg ?? rcText(rc)); } }

export interface Measurement { hz: number; v: number; sd: number; E?: number; N?: number; H?: number; timestamp: string }

export class GeoComClient {
  private trId = 0;
  constructor(private io: Transport, public timeoutMs = 15000) {}

  /** Low-level RPC. Returns the reply parameters (after RC). Throws GeoComError on RC != 0 unless allowRc. */
  async call(rpc: number, params: (number | string)[] = [], opts: { timeoutMs?: number; allowRc?: number[] } = {}): Promise<string[]> {
    const id = ++this.trId;
    const req = `%R1Q,${rpc},${id}:${params.join(",")}\r\n`;
    await this.io.write(req);
    const deadline = Date.now() + (opts.timeoutMs ?? this.timeoutMs);
    while (true) {
      const line = await this.io.readLine(Math.max(1, deadline - Date.now()));
      const parsed = parseReply(line);
      if (!parsed) continue;                          // echo or noise
      if (parsed.trId !== undefined && parsed.trId !== id) continue; // stale reply
      if (parsed.comRc !== 0) throw new GeoComError(parsed.comRc, `Communication error ${parsed.comRc}`);
      if (parsed.rc !== 0 && !(opts.allowRc ?? []).includes(parsed.rc)) throw new GeoComError(parsed.rc);
      return parsed.values;
    }
  }

  async ping(): Promise<boolean> { try { await this.call(RPC.COM_NullProc, [], { timeoutMs: 3000 }); return true; } catch { return false; } }
  async instrumentName(): Promise<string> { return (await this.call(RPC.CSV_GetInstrumentName))[0]?.replace(/"/g, "") ?? ""; }
  async serialNumber(): Promise<string> { return (await this.call(RPC.CSV_GetInstrumentNo))[0] ?? ""; }

  /** Station E0,N0,H0 and instrument height. */
  async setStation(E: number, N: number, H: number, hi: number) { await this.call(RPC.TMC_SetStation, [E, N, H, hi]); }
  async getStation(): Promise<{ E: number; N: number; H: number; hi: number }> {
    const [E, N, H, hi] = (await this.call(RPC.TMC_GetStation)).map(Number); return { E, N, H, hi };
  }
  async setReflectorHeight(hr: number) { await this.call(RPC.TMC_SetHeight, [hr]); }
  /** Orientation: Hz value the instrument reads in its current direction. */
  async setOrientation(hzDeg: number) { await this.call(RPC.TMC_SetOrientation, [hzDeg * Math.PI / 180]); }
  async setMeasureProgram(prg: number) { await this.call(RPC.BAP_SetMeasPrg, [prg]); }
  async setAtr(on: boolean) { await this.call(RPC.AUS_SetUserAtrState, [on ? 1 : 0]); }
  async laserPointer(on: boolean) { await this.call(RPC.EDM_Laserpointer, [on ? 1 : 0]); }

  /** Take a distance+angle measurement; returns Hz/V in degrees, SD in metres, plus reduced coordinates. */
  async measure(opts: { waitMs?: number; inclineMode?: number } = {}): Promise<Measurement> {
    const wait = opts.waitMs ?? 5000, inc = opts.inclineMode ?? TMC_INCLINE.AUTO_INC;
    await this.call(RPC.TMC_DoMeasure, [TMC_MEASURE.DEF_DIST, inc]);
    const [hz, v, sd] = (await this.call(RPC.TMC_GetSimpleMea, [wait, inc], { timeoutMs: wait + 10000 })).map(Number);
    let E: number | undefined, N: number | undefined, H: number | undefined;
    try {
      const c = (await this.call(RPC.TMC_GetCoordinate, [wait, inc], { timeoutMs: wait + 10000, allowRc: [1283, 1284] })).map(Number);
      [E, N, H] = c;
    } catch { /* coordinates need a station set; fall back to polar only */ }
    return { hz: hz * 180 / Math.PI, v: v * 180 / Math.PI, sd, E, N, H, timestamp: new Date().toISOString() };
  }

  /** Angles only (no distance). */
  async angles(): Promise<{ hz: number; v: number }> {
    const [hz, v] = (await this.call(RPC.TMC_GetAngle5, [TMC_INCLINE.AUTO_INC])).map(Number);
    return { hz: hz * 180 / Math.PI, v: v * 180 / Math.PI };
  }

  /** Turn to Hz/V (degrees). Needs robotic licence. posMode 0=normal 1=precise; atrMode 0=position 1=target. */
  async turnTo(hzDeg: number, vDeg: number, atr = false) {
    await this.call(RPC.AUT_MakePositioning, [hzDeg * Math.PI / 180, vDeg * Math.PI / 180, 1, atr ? 1 : 0, 0], { timeoutMs: 60000 });
  }
  /** PowerSearch/ATR search window (degrees). */
  async search(hzWindowDeg = 5, vWindowDeg = 5) {
    await this.call(RPC.AUT_Search, [hzWindowDeg * Math.PI / 180, vWindowDeg * Math.PI / 180, 0], { timeoutMs: 60000 });
  }

  async close() { await this.io.close(); }
}

export function parseReply(line: string): { comRc: number; trId?: number; rc: number; values: string[] } | null {
  const m = /^%R1P,(\d+),(\d+):(.*)$/.exec(line.trim());
  if (!m) return null;
  const parts = m[3].split(",");
  return { comRc: +m[1], trId: +m[2], rc: +parts[0], values: parts.slice(1) };
}

/** In-memory simulator so the UI and tests run without an instrument. */
export class SimulatedInstrument implements Transport {
  private queue: string[] = [];
  station = { E: 1000, N: 2000, H: 100, hi: 1.55 };
  target = { hz: 45.1234, v: 88.5, sd: 23.456 };
  name = "TS16 (simulated)";
  async write(data: string): Promise<void> {
    const m = /^%R1Q,(\d+),(\d+):(.*)$/.exec(data.trim()); if (!m) return;
    const rpc = +m[1], id = +m[2], p = m[3].split(",").map(Number);
    const reply = (rc: number, vals: (number | string)[] = []): void => void this.queue.push(`%R1P,0,${id}:${[rc, ...vals].join(",")}\r\n`);
    switch (rpc) {
      case RPC.COM_NullProc: return reply(0);
      case RPC.CSV_GetInstrumentName: return reply(0, [`"${this.name}"`]);
      case RPC.CSV_GetInstrumentNo: return reply(0, [1234567]);
      case RPC.TMC_SetStation: this.station = { E: p[0], N: p[1], H: p[2], hi: p[3] }; return reply(0);
      case RPC.TMC_GetStation: return reply(0, [this.station.E, this.station.N, this.station.H, this.station.hi]);
      case RPC.TMC_DoMeasure: return reply(0);
      case RPC.TMC_GetSimpleMea: return reply(0, [this.target.hz * Math.PI / 180, this.target.v * Math.PI / 180, this.target.sd]);
      case RPC.TMC_GetAngle5: return reply(0, [this.target.hz * Math.PI / 180, this.target.v * Math.PI / 180]);
      case RPC.TMC_GetCoordinate: {
        const hz = this.target.hz * Math.PI / 180, v = this.target.v * Math.PI / 180, hd = this.target.sd * Math.sin(v);
        return reply(0, [this.station.E + hd * Math.sin(hz), this.station.N + hd * Math.cos(hz), this.station.H + this.station.hi + this.target.sd * Math.cos(v), 0, 0, 0, 0, 0]);
      }
      case RPC.AUT_MakePositioning: this.target.hz = p[0] * 180 / Math.PI; this.target.v = p[1] * 180 / Math.PI; return reply(0);
      default: return reply(0);
    }
  }
  async readLine(timeoutMs: number): Promise<string> {
    const t0 = Date.now();
    while (!this.queue.length) { if (Date.now() - t0 > timeoutMs) throw new Error("timeout"); await new Promise(r => setTimeout(r, 5)); }
    return this.queue.shift()!;
  }
  async close() {}
}
