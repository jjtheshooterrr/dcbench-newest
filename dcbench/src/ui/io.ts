// File open/save that works inside Tauri (native dialogs) and in a plain browser (dev fallback).
const inTauri = () => typeof (window as any).__TAURI_INTERNALS__ !== "undefined";

export async function openTextFile(filters: { name: string; extensions: string[] }[]): Promise<{ name: string; text: string } | null> {
  if (inTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, filters });
    if (!path) return null;
    const p = typeof path === "string" ? path : (path as any).path;
    return { name: p.split(/[\\/]/).pop()!, text: await readTextFile(p) };
  }
  return new Promise(res => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = filters.flatMap(f => f.extensions.map(e => "." + e)).join(",");
    inp.onchange = async () => { const f = inp.files?.[0]; if (!f) return res(null); res({ name: f.name, text: await f.text() }); };
    inp.click();
  });
}

export async function saveTextFile(defaultName: string, text: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  if (inTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: defaultName, filters });
    if (!path) return null;
    await writeTextFile(path, text);
    return path;
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = defaultName; a.click();
  return defaultName;
}

export function toast(msg: string) {
  let t = document.querySelector<HTMLDivElement>(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("on"); setTimeout(() => t!.classList.remove("on"), 1800);
}
