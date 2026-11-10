// Serial transport for GeoCOM via tauri-plugin-serialplugin (RS232 or Bluetooth SPP COM port).
import { Transport } from "./geocom";

// Loaded lazily so the core stays testable in Node without the Tauri runtime.
type SerialModule = typeof import("tauri-plugin-serialplugin");

export async function listSerialPorts(): Promise<{ path: string; label: string }[]> {
  const mod: SerialModule = await import("tauri-plugin-serialplugin");
  const ports = await mod.SerialPort.available_ports();
  return Object.entries(ports).map(([path, info]: [string, any]) => ({ path, label: `${path}${info?.product ? ` — ${info.product}` : ""}${info?.type ? ` (${info.type})` : ""}` }));
}

export class SerialTransport implements Transport {
  private port: any; private buf = ""; private lines: string[] = []; private unlisten?: () => void;
  private constructor() {}
  static async open(path: string, baudRate = 115200): Promise<SerialTransport> {
    const mod: SerialModule = await import("tauri-plugin-serialplugin");
    const t = new SerialTransport();
    t.port = new mod.SerialPort({ path, baudRate, dataBits: 8, stopBits: 1, parity: "None", flowControl: "None", timeout: 200 } as any);
    await t.port.open();
    await t.port.startListening();
    t.unlisten = await t.port.listen((data: any) => {
      const s = typeof data === "string" ? data : new TextDecoder().decode(data);
      t.buf += s;
      let i: number;
      while ((i = t.buf.indexOf("\n")) >= 0) { t.lines.push(t.buf.slice(0, i + 1)); t.buf = t.buf.slice(i + 1); }
    }, false);
    return t;
  }
  async write(data: string) { await this.port.write(data); }
  async readLine(timeoutMs: number): Promise<string> {
    const t0 = Date.now();
    while (!this.lines.length) { if (Date.now() - t0 > timeoutMs) throw new Error("No reply from instrument (timeout)"); await new Promise(r => setTimeout(r, 10)); }
    return this.lines.shift()!;
  }
  async close() { try { this.unlisten?.(); await this.port.stopListening(); await this.port.close(); } catch { /* already closed */ } }
}
