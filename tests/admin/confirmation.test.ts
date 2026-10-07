/** @vitest-environment jsdom */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountConsoleDialog } from "../../src/admin/client/main";
import { element, submit } from "../support/browser-dom";
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {configurable: true, value: true});
let dispose: (() => void) | null = null;
afterEach(async () => { await act(() => {dispose?.();}); dispose = null; document.body.innerHTML = ""; vi.restoreAllMocks(); });
const message = "撤销这个密钥。正在使用它的客户端会立刻失败，而且不能恢复。";
function page(): HTMLFormElement {
  document.body.innerHTML = `<div id="console-dialog-root"></div><form data-confirmation="${message}"><label data-confirmation-fallback><input type="checkbox" required>${message}</label><button type="submit">撤销</button></form>`;
  return element("form", HTMLFormElement);
}
async function mount(): Promise<void> { await act(() => {dispose = mountConsoleDialog(element("#console-dialog-root", HTMLElement));}); }
describe("shadcn Radix action confirmation", () => {
  it("retains the required native confirmation before scripts start", () => {
    const form = page(); expect(form.checkValidity()).toBe(false); element("input", HTMLInputElement).checked = true; expect(form.checkValidity()).toBe(true);
  });
  it("shows the exact impact, starts on Cancel and restores the trigger focus", async () => {
    const form = page(); const button = element("button[type=submit]", HTMLButtonElement); button.focus(); const posted = vi.spyOn(form, "requestSubmit").mockImplementation(() => {}); await mount(); await act(() => {submit(form);});
    expect(element("[role=alertdialog]", HTMLElement).textContent).toContain(message); expect(document.activeElement).toBe(element(".confirmation-cancel", HTMLButtonElement));
    await act(() => {element(".confirmation-cancel", HTMLButtonElement).click();}); expect(posted).not.toHaveBeenCalled(); await vi.waitFor(() => expect(document.activeElement).toBe(button));
    expect(element("input", HTMLInputElement).disabled).toBe(true);
  });
  it("submits once with the original submitter when confirmed", async () => {
    const form = page(); const button = element("button[type=submit]", HTMLButtonElement); const posted = vi.spyOn(form, "requestSubmit").mockImplementation(() => {}); await mount(); await act(() => {submit(form);}); await act(() => {element(".confirmation-submit", HTMLButtonElement).click();});
    expect(posted).toHaveBeenCalledExactlyOnceWith(button); expect(document.querySelector("[role=alertdialog]")).toBe(null);
  });
  it("names the selected service owner and distinguishes explicit removal", async () => {
    const form = page(); form.setAttribute("data-confirm-service-owner", "");
    form.insertAdjacentHTML("afterbegin", '<select name="owner_selection"><option value="">移除分配，保持管理员管理</option><option value="next" selected>next@example.test（next）</option></select>');
    await mount(); await act(() => {submit(form);});
    expect(element("[role=alertdialog]", HTMLElement).textContent).toContain("新的管理人：next@example.test（next）");
    await act(() => {element(".confirmation-cancel", HTMLButtonElement).click();});
    element("select", HTMLSelectElement).value = "";
    await act(() => {submit(form);});
    expect(element("[role=alertdialog]", HTMLElement).textContent).toContain("新的管理人：移除分配，保持管理员管理");
  });
  it.each(["credential_account_id", "replacement_account_id"])("names the exact selected credential for %s", async name => {
    const form = page(); form.setAttribute("data-confirm-credential", "");
    form.insertAdjacentHTML("afterbegin", `<select name="${name}"><option value="first">Codex · First</option><option value="second" selected>Codex · Second (second)</option></select>`);
    await mount(); await act(() => {submit(form);});
    expect(element("[role=alertdialog]", HTMLElement).textContent).toContain("选择的连接：Codex · Second (second)");
    expect(element("[role=alertdialog]", HTMLElement).textContent).not.toContain("First");
  });
  it("does not submit a removed form", async () => {
    const form = page(); const posted = vi.spyOn(form, "requestSubmit").mockImplementation(() => {}); await mount(); await act(() => {submit(form);}); form.remove(); await act(() => {element(".confirmation-submit", HTMLButtonElement).click();}); expect(posted).not.toHaveBeenCalled();
  });
});
