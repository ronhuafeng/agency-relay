import { buttonVariants } from "../ui/components/button";
/** Only allowlisted, non-secret inputs survive in-document navigation. */
type DraftField = HTMLInputElement | HTMLSelectElement;
interface Value { name: string; type: string; value: string; checked: boolean | null }
interface Draft { baseline: Value[]; values: Value[] }
export interface Drafts {
  capture(root: ParentNode): void;
  restore(root: ParentNode, retryForm?: HTMLFormElement | null): boolean;
  discard(form: HTMLFormElement): void;
  clear(): void;
  dispose(): void;
}
const fields: Readonly<Record<string, readonly string[]>> = {
  person: ["id", "email"], service: ["display_name"], "service-name": ["display_name"], "service-classify": ["display_name"], account: ["label"],
  access: ["name", "clients", "expires_at_utc", "codex_credential_account_id", "grok_credential_account_id", "xai_credential_account_id"],
  binding: ["credential_account_id"], replacement: ["expires_at_utc"], credit: ["mode", "monthly_allowance"], "credit-defaults":["codex","grok","xai"], sync: ["client"]
};
function forms(root: ParentNode): HTMLFormElement[] {
  return Array.from(root.querySelectorAll<HTMLFormElement>("form[data-dashboard-draft]"));
}
function key(form: HTMLFormElement): string {
  return JSON.stringify([form.dataset.dashboardDraft, form.getAttribute("action") ?? "", form.dataset.draftScope ?? ""]);
}
function controls(form: HTMLFormElement): DraftField[] {
  const allowed = fields[form.dataset.dashboardDraft ?? ""] ?? [];
  return Array.from(form.elements).filter((field): field is DraftField =>
    (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) && allowed.includes(field.name) &&
    ["text", "email", "number", "datetime-local", "select-one", "checkbox"].includes(field.type) &&
    (!field.disabled || form.dataset.dashboardDraft === "credit" && field.name === "monthly_allowance"));
}
function snapshot(form: HTMLFormElement): Value[] {
  return controls(form).map((field) => ({ name: field.name, type: field.type, value: field.value, checked: field instanceof HTMLInputElement && field.type === "checkbox" ? field.checked : null }));
}
function equal(a: readonly Value[], b: readonly Value[]): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function showState(form: HTMLFormElement, dirty: boolean): void {
  let state = form.querySelector<HTMLElement>("[data-draft-state]");
  if (!state && dirty) {
    state = document.createElement("div"); state.dataset.draftState = ""; state.className = "draft-state";
    const label = document.createElement("span"); label.textContent = "有未保存的修改"; label.setAttribute("role", "status"); state.append(label);
    if (!form.querySelector("[data-discard-draft]")) {
      const discard = document.createElement("button"); discard.type = "button"; discard.dataset.discardDraft = "";
      discard.className = buttonVariants({variant: "outline"}); discard.dataset.slot = "button"; discard.textContent = "放弃修改"; state.append(discard);
    }
    form.append(state);
  }
  if (state) state.hidden = !dirty;
}
function apply(form: HTMLFormElement, values: readonly Value[]): void {
  controls(form).forEach((field, index) => {
    const value = values[index]; if (!value || value.name !== field.name || value.type !== field.type) return;
    if (field instanceof HTMLInputElement && field.type === "checkbox") field.checked = value.checked === true;
    else field.value = value.value;
  });
  form.dispatchEvent(new Event("console:restore"));
}
export function createDrafts(): Drafts {
  const listeners = new AbortController();
  const signal = listeners.signal;
  const drafts = new Map<string, Draft>(); const baselines = new WeakMap<HTMLFormElement, Value[]>(); const suppressed = new WeakSet<HTMLFormElement>();
  const captureForm = (form: HTMLFormElement): void => {
    if (!fields[form.dataset.dashboardDraft ?? ""] || suppressed.has(form)) return;
    const baseline = baselines.get(form); if (!baseline) return;
    const values = snapshot(form); const dirty = !equal(values, baseline);
    if (dirty) drafts.set(key(form), { baseline, values }); else drafts.delete(key(form)); showState(form, dirty);
  };
  const onInput = (event: Event): void => {
    const field = event.target;
    if ((field instanceof HTMLInputElement || field instanceof HTMLSelectElement) && field.form) captureForm(field.form);
  };
  document.addEventListener("input", onInput, {signal}); document.addEventListener("change", onInput, {signal});
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-discard-draft]") : null;
    const form = target?.closest("form[data-dashboard-draft]"); if (!(form instanceof HTMLFormElement)) return;
    const baseline = baselines.get(form); if (!baseline) return;
    showState(form, false); apply(form, baseline); drafts.delete(key(form)); controls(form)[0]?.focus(); form.dispatchEvent(new Event("console:discard"));
  }, {signal});
  return {
    capture: (root) => forms(root).forEach(captureForm),
    restore: (root, retryForm = null) => {
      let changed = false;
      for (const form of forms(root)) {
        const fresh = snapshot(form); const saved = drafts.get(key(form)); const retry = saved && retryForm && key(form) === key(retryForm);
        baselines.set(form, retry ? saved.baseline : fresh); if (!saved) continue;
        const current = controls(form);
        const available = current.length === saved.values.length && current.every((field, index) => {
          const value = saved.values[index]; if (!value || field.name !== value.name || field.type !== value.type) return false;
          return !(field instanceof HTMLSelectElement) || Array.from(field.options).some((option) => option.value === value.value && !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled));
        });
        if ((!retry && !equal(fresh, saved.baseline)) || !available) { drafts.delete(key(form)); changed = true; continue; }
        apply(form, saved.values); showState(form, true);
      }
      return changed;
    },
    discard: (form) => { drafts.delete(key(form)); suppressed.add(form); showState(form, false); },
    clear: () => drafts.clear(),
    dispose: () => { listeners.abort(); drafts.clear(); }
  };
}
