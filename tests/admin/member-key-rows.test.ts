/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initializeMemberKeyRows, disposeMemberKeyRows } from "../../src/admin/client/member-key-rows";

function page(collection = "/admin?area=me&view=keys", selected: string | null = null): string {
  return `<main id="content" data-console-read-url="${collection}${selected ? `&key=${selected}` : ""}"><div class="member-key-workspace"><section data-member-key-collection="${collection}">
    <table><thead><tr><th><a href="#member-key-form" data-member-create-toggle aria-expanded="true">Create</a></th></tr></thead><tbody>
      <tr data-member-create-row><td colspan="2"><form data-member-key-create><input name="name"><a href="${collection}" data-member-create-close data-member-enhanced-only hidden>Cancel</a></form></td></tr>
      ${["first","second"].map(id=>`<tr data-key-id="${id}" ${selected===id ? 'data-state="selected"' : ""}><td><a href="${collection}&key=${id}" data-member-key-toggle="${id}">Manage ${id}</a></td></tr>
        <tr data-member-key-row="${id}" ${selected===id ? 'data-member-key-open="true"' : "hidden"}><td colspan="2"><section data-key-detail="${id}"><a href="${collection}" data-member-key-close="${id}">Close</a><form><input name="name" value="${id}"></form></section></td></tr>`).join("")}
      ${selected==="foreign" ? '<tr data-member-key-missing><td>No such key</td></tr>' : ""}
    </tbody></table></section></div></main>`;
}
const get = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!;
const row = (id: string): HTMLElement => get(`[data-member-key-row="${id}"]`);
const toggle = (id: string): HTMLAnchorElement => get(`[data-key-id="${id}"] [data-member-key-toggle]`);
beforeEach(()=>{
  history.replaceState(null,"","/admin?area=me&view=keys");
  document.body.innerHTML = page();
});
afterEach(()=>{disposeMemberKeyRows();vi.restoreAllMocks();vi.unstubAllGlobals();});

it("locally opens the exact authorized row, retains collapsed drafts and makes no request",()=>{
  const fetch = vi.fn(); vi.stubGlobal("fetch",fetch);
  const main = get<HTMLElement>("main"); const draft = get<HTMLInputElement>('[data-key-detail="second"] input');
  initializeMemberKeyRows(document);
  toggle("second").click();
  expect(row("second").hidden).toBe(false);expect(row("first").hidden).toBe(true);
  expect(toggle("second").getAttribute("aria-expanded")).toBe("true");
  expect(main.dataset.consoleReadUrl).toBe("/admin?area=me&view=keys&key=second");
  expect(location.search).toBe("?area=me&view=keys");
  draft.value = "Unsaved name";
  toggle("first").click();toggle("second").click();
  expect(get<HTMLInputElement>('[data-key-detail="second"] input')).toBe(draft);
  expect(draft.value).toBe("Unsaved name");expect(document.querySelectorAll("[data-key-detail]")).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
});

it("closes a native exact selection to a collection read and returns focus to its trigger",()=>{
  history.replaceState(null,"","/admin?area=me&view=keys&key=second");
  document.body.innerHTML=page("/admin?area=me&view=keys","second");
  initializeMemberKeyRows(document);
  get<HTMLAnchorElement>('[data-member-key-close="second"]').click();
  expect(row("second").hidden).toBe(true);
  expect(get<HTMLElement>("main").dataset.consoleReadUrl).toBe("/admin?area=me&view=keys");
  expect(location.search).toBe("?area=me&view=keys&key=second");
  expect(document.activeElement).toBe(toggle("second"));
  expect(toggle("second").getAttribute("aria-expanded")).toBe("false");
});

it("moves focus from a now-hidden family link to the selected inventory row",()=>{
  const fetch = vi.fn(); vi.stubGlobal("fetch",fetch);
  const family = document.createElement("a");
  family.href = toggle("second").href; family.dataset.memberKeyToggle = "second";
  get<HTMLElement>('[data-key-detail="first"]').appendChild(family);
  initializeMemberKeyRows(document);toggle("first").click();family.focus();family.click();
  expect(row("first").hidden).toBe(true);expect(row("second").hidden).toBe(false);
  expect(document.activeElement).toBe(toggle("second"));
  expect(get<HTMLElement>("main").dataset.consoleReadUrl).toBe("/admin?area=me&view=keys&key=second");
  get<HTMLAnchorElement>('[data-member-key-close="second"]').click();
  expect(document.activeElement).toBe(toggle("second"));
  expect(fetch).not.toHaveBeenCalled();
});

it("can open, cancel and reopen creation without losing values or changing key selection",()=>{
  initializeMemberKeyRows(document);toggle("second").click();
  const trigger=get<HTMLAnchorElement>("[data-member-create-toggle]");const create=get<HTMLElement>("[data-member-create-row]");
  expect(create.hidden).toBe(true);trigger.click();
  expect(create.hidden).toBe(false);expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const name=get<HTMLInputElement>("[data-member-key-create] input");name.value="New workstation";
  get<HTMLAnchorElement>("[data-member-create-close]").click();
  expect(create.hidden).toBe(true);expect(document.activeElement).toBe(trigger);
  trigger.click();expect(create.hidden).toBe(false);expect(name.value).toBe("New workstation");
  expect(get<HTMLElement>("main").dataset.consoleReadUrl).toBe("/admin?area=me&view=keys&key=second");
  trigger.click();expect(create.hidden).toBe(true);
});

it("opens the native creation fragment and never substitutes a missing exact target",()=>{
  history.replaceState(null,"","/admin?area=me&view=keys&key=foreign#member-key-form");
  document.body.innerHTML=page("/admin?area=me&view=keys","foreign");initializeMemberKeyRows(document);
  expect(get<HTMLElement>("[data-member-create-row]").hidden).toBe(false);
  expect([row("first").hidden,row("second").hidden]).toEqual([true,true]);
  expect(get<HTMLElement>("[data-member-key-missing]").hidden).toBe(false);
  toggle("first").click();expect(get<HTMLElement>("[data-member-key-missing]").hidden).toBe(true);
});

it.each(["pending","unknown","authority"])("keeps %s state visible instead of changing the active row",state=>{
  document.body.innerHTML=page("/admin?area=me&view=keys","first");initializeMemberKeyRows(document);
  const main=get<HTMLElement>("main");
  if(state==="pending")get<HTMLFormElement>('[data-key-detail="first"] form').setAttribute("aria-busy","true");
  if(state==="unknown")main.dataset.memberMutationBlocked="true";
  if(state==="authority")document.documentElement.setAttribute("data-console-authority-pending","");
  try {
    toggle("second").click();get<HTMLAnchorElement>('[data-member-key-close="first"]').click();get<HTMLAnchorElement>("[data-member-create-toggle]").click();
    expect(row("first").hidden).toBe(false);expect(row("second").hidden).toBe(true);
    expect(get<HTMLElement>("[data-member-create-row]").hidden).toBe(true);
    expect(main.dataset.consoleReadUrl).toBe("/admin?area=me&view=keys&key=first");
  } finally {document.documentElement.removeAttribute("data-console-authority-pending");}
});

it("uses the current delegated scope after a mutation replaces main",()=>{
  const collection="/me/service-accounts/nightly?view=keys";
  history.replaceState(null,"",collection);document.body.innerHTML=page(collection,"first");initializeMemberKeyRows(document);
  const previous=get<HTMLElement>("main");previous.dataset.memberMutationBlocked="true";
  const next=document.createElement("div");next.innerHTML=page(collection,"second");previous.replaceWith(next.firstElementChild!);
  initializeMemberKeyRows(document);toggle("first").click();
  expect(row("first").hidden).toBe(false);expect(row("second").hidden).toBe(true);
  expect(get<HTMLElement>("main").dataset.consoleReadUrl).toBe(collection+"&key=first");
  get<HTMLAnchorElement>('[data-member-key-close="first"]').click();
  expect(get<HTMLElement>("main").dataset.consoleReadUrl).toBe(collection);
});
