let listeners: AbortController | null = null;

function inventory(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-member-key-collection]");
}

function locked(root: HTMLElement): boolean {
  const main = root.closest<HTMLElement>("main");
  return document.documentElement.hasAttribute("data-console-authority-pending")
    || main?.dataset.mutationPending === "true" || main?.dataset.memberMutationBlocked === "true"
    || main?.getAttribute("aria-busy") === "true"
    || Boolean(main?.querySelector('form[aria-busy="true"],[data-one-time-key]'));
}

function select(root: HTMLElement, id: string | null): void {
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-member-key-row]"));
  const selected = rows.find(row => row.dataset.memberKeyRow === id);
  for (const row of rows) {
    row.hidden = row !== selected;
    if (row === selected) row.dataset.memberKeyOpen = "true"; else delete row.dataset.memberKeyOpen;
  }
  root.querySelectorAll<HTMLElement>("[data-member-key-toggle]").forEach(trigger => {
    const open = trigger.dataset.memberKeyToggle === selected?.dataset.memberKeyRow;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) trigger.setAttribute("aria-current", "true"); else trigger.removeAttribute("aria-current");
  });
  root.querySelectorAll<HTMLElement>("[data-key-id]").forEach(row => {
    if (row.dataset.keyId === selected?.dataset.memberKeyRow) row.dataset.state = "selected"; else delete row.dataset.state;
  });
  root.querySelectorAll<HTMLElement>("[data-member-key-missing]").forEach(row => { row.hidden = Boolean(selected) || id === null; });
  const workspace = root.closest<HTMLElement>(".member-key-workspace");
  if (workspace) workspace.dataset.selectedKey = String(Boolean(selected));
}

function create(root: HTMLElement, open: boolean): void {
  const row = root.querySelector<HTMLElement>("[data-member-create-row]");
  if (!row) return;
  row.hidden = !open;
  if (open) row.dataset.memberKeyOpen = "true"; else delete row.dataset.memberKeyOpen;
  root.querySelectorAll<HTMLElement>("[data-member-create-toggle]").forEach(trigger => trigger.setAttribute("aria-expanded",String(open)));
}

function address(root: HTMLElement, href: string): void {
  const target = new URL(href,location.href);
  const collection = new URL(root.dataset.memberKeyCollection!,location.href);
  if (target.origin !== location.origin || target.pathname !== collection.pathname || target.searchParams.get("view") !== "keys") return;
  target.hash = "";
  const main = root.closest<HTMLElement>("main");
  if (main) main.dataset.consoleReadUrl = target.pathname + target.search;
}

/** Enhance only the current server-authorized rows. No reads, hidden key material,
 * or new write path is introduced; native links remain exact GET targets. */
export function initializeMemberKeyRows(scope: ParentNode): void {
  const root = scope instanceof HTMLElement && scope.matches("[data-member-key-collection]")
    ? scope : scope.querySelector<HTMLElement>("[data-member-key-collection]");
  if (!root) return;
  if (root.dataset.memberKeysEnhanced !== "true") {
    root.dataset.memberKeysEnhanced = "true";
    root.querySelectorAll<HTMLElement>("[data-member-enhanced-only]").forEach(control => {control.hidden = false;});
    create(root,location.hash === "#member-key-form");
  }
  if (listeners) return;
  listeners = new AbortController(); const signal = listeners.signal;
  document.addEventListener("click",event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const trigger = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-member-key-toggle],a[data-member-key-close],a[data-member-create-toggle],a[data-member-create-close]") : null;
    const current = inventory(); if (!trigger || !current?.contains(trigger)) return;
    event.preventDefault(); if (locked(current)) return;
    if (trigger.hasAttribute("data-member-create-toggle") || trigger.hasAttribute("data-member-create-close")) {
      const row = current.querySelector<HTMLElement>("[data-member-create-row]");
      const open = trigger.hasAttribute("data-member-create-toggle") && Boolean(row?.hidden);
      create(current,open);
      if (!open) current.querySelector<HTMLElement>("[data-member-create-toggle]")?.focus();
      return;
    }
    const id = trigger.dataset.memberKeyToggle ?? trigger.dataset.memberKeyClose;
    const row = Array.from(current.querySelectorAll<HTMLElement>("[data-member-key-row]")).find(candidate=>candidate.dataset.memberKeyRow===id);
    if (!row) return;
    const open = trigger.hasAttribute("data-member-key-toggle") && row.hidden;
    select(current,open ? id! : null);
    address(current,open ? trigger.href : current.dataset.memberKeyCollection!);
    const controls = Array.from(current.querySelectorAll<HTMLElement>("[data-member-key-toggle]"));
    if (open) {
      current.querySelectorAll<HTMLElement>("[data-member-key-focus]").forEach(control=>control.removeAttribute("data-member-key-focus"));
      const focus = trigger.closest("[hidden]")
        ? controls.find(control=>control.dataset.memberKeyToggle===id && !control.closest("[hidden]"))
        : trigger;
      if (focus) {
        focus.dataset.memberKeyFocus = "";
        if (focus !== trigger) focus.focus();
      }
    } else {
      (controls.find(control=>control.dataset.memberKeyToggle===id && control.hasAttribute("data-member-key-focus"))
        ?? controls.find(control=>control.dataset.memberKeyToggle===id && !control.closest("[hidden]")))?.focus();
    }
  },{signal});
}

export function disposeMemberKeyRows(): void { listeners?.abort(); listeners = null; }
