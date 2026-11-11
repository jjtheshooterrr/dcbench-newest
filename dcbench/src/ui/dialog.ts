// In-app modal dialogs. The native window.prompt/confirm are unreliable inside desktop webviews.
function modal<T>(build: (box: HTMLElement, done: (v: T) => void) => { cancel: T; focus?: HTMLElement }): Promise<T> {
  return new Promise(resolve => {
    const bg = document.createElement("div"); bg.className = "modal-bg";
    const box = document.createElement("div"); box.className = "modal"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    bg.append(box); document.body.append(bg);
    const prev = document.activeElement as HTMLElement | null;
    const done = (v: T) => { document.removeEventListener("keydown", onKey, true); bg.remove(); prev?.focus?.(); resolve(v); };
    const spec = build(box, done);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(spec.cancel); }
      if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); e.stopPropagation(); box.querySelector<HTMLButtonElement>("button.primary")?.click(); }
    };
    document.addEventListener("keydown", onKey, true);
    bg.addEventListener("mousedown", e => { if (e.target === bg) done(spec.cancel); });
    (spec.focus ?? box.querySelector<HTMLElement>("button.primary"))?.focus();
  });
}
const msgEl = (text: string) => { const p = document.createElement("div"); p.className = "modal-msg"; p.textContent = text; return p; };
const buttons = (...defs: [string, boolean, () => void][]) => {
  const row = document.createElement("div"); row.className = "actions modal-actions";
  for (const [label, primary, fn] of defs) { const b = document.createElement("button"); b.className = "btn" + (primary ? " primary" : ""); b.textContent = label; b.onclick = fn; row.append(b); }
  return row;
};

export const confirmBox = (message: string, okLabel = "OK") =>
  modal<boolean>((box, done) => { box.append(msgEl(message), buttons(["Cancel", false, () => done(false)], [okLabel, true, () => done(true)])); return { cancel: false }; });

export const notify = (message: string) =>
  modal<void>((box, done) => { box.append(msgEl(message), buttons(["OK", true, () => done()])); return { cancel: undefined }; });

/** Ask for one value. With `options` it is a pick list, otherwise free text. Resolves null on cancel. */
export const promptBox = (label: string, initial = "", options?: string[]) =>
  modal<string | null>((box, done) => {
    let field: HTMLInputElement | HTMLSelectElement;
    if (options) { field = document.createElement("select"); for (const o of options) field.add(new Option(o, o, false, o === initial)); }
    else { field = document.createElement("input"); field.type = "text"; field.value = initial; }
    field.className = "modal-field"; field.id = "modalField";
    box.append(msgEl(label), field, buttons(["Cancel", false, () => done(null)], ["OK", true, () => done(field.value)]));
    if (field instanceof HTMLInputElement) setTimeout(() => (field as HTMLInputElement).select(), 0);
    return { cancel: null, focus: field };
  });
