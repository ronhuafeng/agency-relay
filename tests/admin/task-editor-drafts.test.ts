/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { createDrafts, type Drafts } from "../../src/admin/client/drafts";
import { TaskEditorView, readTaskEditor, type TaskEditorControl } from "../../src/admin/ui/task-editor";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {configurable: true, value: true});
let root: Root | null = null; let drafts: Drafts | null = null;
afterEach(async () => {await act(() => root?.unmount()); root = null; drafts?.dispose(); drafts = null; document.body.replaceChildren();});
const control = (person: string): TaskEditorControl => ({id:`email-${person}`, label:"更改登录邮箱", action:`/admin/ui/users/${person}/email`, submitLabel:"迁移邮箱", fields:[{name:"email",label:"新的组织邮箱",type:"email",value:""}], hidden:{confirm:"1",person_return:`/admin?view=access&person=${person}`}, draftKind:"person", draftScope:person});
const render = (person: string) => {document.body.innerHTML = renderToStaticMarkup(createElement(TaskEditorView, {control:control(person)}));};

it("retains only safe email input for its exact task while keeping island IDs separate", () => {
  render("other"); drafts = createDrafts(); drafts.restore(document);
  const form = document.querySelector("form")!;
  expect(form.dataset.dashboardDraft).toBe("person"); expect(form.dataset.draftScope).toBe("other");
  const email = form.querySelector<HTMLInputElement>('[name="email"]')!; email.value = "unfinished@example.test";
  email.dispatchEvent(new Event("input", {bubbles:true}));
  expect(form.querySelector('[data-draft-state]:not([hidden])')).not.toBeNull();
  render("another"); drafts.restore(document); expect(document.querySelector<HTMLInputElement>('[name="email"]')!.value).toBe("");
  render("other"); drafts.restore(document); expect(document.querySelector<HTMLInputElement>('[name="email"]')!.value).toBe("unfinished@example.test");
  document.querySelector<HTMLButtonElement>('[data-discard-draft]')!.click();
  expect(document.querySelector<HTMLInputElement>('[name="email"]')!.value).toBe("");
  expect(document.querySelector<HTMLInputElement>('[name="confirm"]')!.value).toBe("1");
  expect(readTaskEditor({...control("other"),draftKind:"email-other"})).toBeNull();
});

it("cancels a mounted editor back to its visible trigger while preserving input", async () => {
  const mount = document.createElement("div"); document.body.append(mount); root = createRoot(mount);
  await act(() => root!.render(createElement(TaskEditorView, {control:control("other")})));
  const trigger = mount.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!;
  await act(() => trigger.click());
  const email = mount.querySelector<HTMLInputElement>('[name="email"]')!; email.value = "unfinished@example.test";
  const cancel = Array.from(mount.querySelectorAll<HTMLButtonElement>("button")).find(button=>button.textContent === "取消")!;
  cancel.focus(); await act(() => cancel.click());
  expect(document.activeElement).toBe(trigger); expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(() => trigger.click()); expect(email.value).toBe("unfinished@example.test");
});

it("makes a restored email task visible and labels a retained draft after cancellation", async () => {
  let mount = document.createElement("div"); document.body.append(mount); root = createRoot(mount);
  await act(() => root!.render(createElement(TaskEditorView, {control:control("other")})));
  drafts = createDrafts(); drafts.restore(document);
  await act(() => mount.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!.click());
  const email = mount.querySelector<HTMLInputElement>('[name="email"]')!;
  await act(async () => {email.value = "unfinished@example.test"; email.dispatchEvent(new Event("input",{bubbles:true})); await Promise.resolve();});
  await act(() => Array.from(mount.querySelectorAll<HTMLButtonElement>("button")).find(button=>button.textContent === "取消")!.click());
  expect(mount.querySelector('[data-task-draft-indicator]')?.textContent).toBe("有未保存的修改");
  await act(() => root!.unmount());
  document.body.replaceChildren(); mount = document.createElement("div"); document.body.append(mount); root = createRoot(mount);
  await act(() => root!.render(createElement(TaskEditorView, {control:control("other")})));
  await act(async () => {drafts!.restore(document); await Promise.resolve();});
  expect(mount.querySelector('[data-slot="collapsible-trigger"]')?.getAttribute("aria-expanded")).toBe("true");
  expect(mount.querySelector<HTMLInputElement>('[name="email"]')!.value).toBe("unfinished@example.test");
  expect(mount.querySelector('[data-slot="collapsible-content"]')?.hasAttribute("hidden")).toBe(false);
  await act(async () => {mount.querySelector<HTMLButtonElement>('[data-discard-draft]')!.click(); await Promise.resolve();});
  expect(mount.querySelector<HTMLInputElement>('[name="email"]')!.value).toBe("");
  await act(() => Array.from(mount.querySelectorAll<HTMLButtonElement>("button")).find(button=>button.textContent === "取消")!.click());
  expect(mount.querySelector('[data-task-draft-indicator]')).toBeNull();
});
