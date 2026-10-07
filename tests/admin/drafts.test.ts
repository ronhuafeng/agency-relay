/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDrafts, type Drafts } from "../../src/admin/client/drafts";
import { element } from "../support/browser-dom";
let drafts: Drafts | null = null;
afterEach(() => { drafts?.dispose(); drafts = null; vi.restoreAllMocks(); });
function form(email = ""): HTMLFormElement {
  document.body.innerHTML = `<form action="/admin/ui/users" data-dashboard-draft="person"><input name="id" value="Alex"><input type="email" name="email" value="${email}"><input type="password" name="callback_url"><input type="hidden" name="token" value="synthetic"><button type="submit">添加</button></form>`;
  return element("form", HTMLFormElement);
}
describe("non-secret in-document drafts", () => {
  it("restores only allowlisted controls to the same action", () => {
    const original = form(); drafts = createDrafts(); drafts.restore(document);
    element('[name="email"]', HTMLInputElement).value = "alex@example.test"; element('[name="callback_url"]', HTMLInputElement).value = "synthetic-private"; drafts.capture(document);
    form(); expect(drafts.restore(document)).toBe(false); expect(element('[name="email"]', HTMLInputElement).value).toBe("alex@example.test"); expect(element('[name="callback_url"]', HTMLInputElement).value).toBe(""); expect(document.body.textContent).toContain("有未保存的修改");
    expect(original.isConnected).toBe(false);
  });
  it("drops a draft if the server baseline changed", () => {
    form(); drafts = createDrafts(); drafts.restore(document); element('[name="email"]', HTMLInputElement).value = "alex@example.test"; drafts.capture(document);
    form("changed@example.test"); expect(drafts.restore(document)).toBe(true); expect(element('[name="email"]', HTMLInputElement).value).toBe("changed@example.test");
  });
  it("keeps a credit mode and its inactive allowance in the same draft", () => {
    const markup = '<form action="/admin/ui/credits/preview/codex" data-dashboard-draft="credit"><select name="mode"><option value="limited">限额</option><option value="unlimited">不限</option></select><input type="number" name="monthly_allowance" value="25"></form>';
    document.body.innerHTML = markup; drafts = createDrafts(); drafts.restore(document);
    element("select", HTMLSelectElement).value = "unlimited"; const amount = element("input", HTMLInputElement); amount.value = "30"; amount.disabled = true; drafts.capture(document);
    document.body.innerHTML = markup; drafts.restore(document);
    expect(element("select", HTMLSelectElement).value).toBe("unlimited"); expect(element("input", HTMLInputElement).value).toBe("30");
  });
  it("discards a draft and restores the baseline without storing history or secrets", () => {
    form(); drafts = createDrafts(); drafts.restore(document); const input = element('[name="id"]', HTMLInputElement); input.value = "Edited"; input.dispatchEvent(new Event("input", {bubbles: true}));
    element("[data-discard-draft]", HTMLButtonElement).click(); expect(input.value).toBe("Alex"); form(); expect(drafts.restore(document)).toBe(false); expect(element('[name="id"]', HTMLInputElement).value).toBe("Alex");
  });
});
