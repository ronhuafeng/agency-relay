/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { CopySecretView, DisclosureView } from "../../src/admin/ui/secrets";
import { element } from "../support/browser-dom";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const token = "invalid-display-only-" + "long-value-".repeat(30);
let root: Root | null = null;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(async () => {
  await act(() => root?.unmount()); root = null;
  document.body.innerHTML = "";
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});
function clipboard(value: unknown): void { Object.defineProperty(navigator, "clipboard", { configurable: true, value }); }
async function mount(disclosure = false): Promise<void> {
  document.body.innerHTML = '<div id="root"></div><button id="elsewhere">Elsewhere</button>';
  root = createRoot(element("#root", HTMLElement));
  await act(() => root?.render(disclosure
    ? createElement(DisclosureView, { control: { id: "test-secret", title: "手动复制密钥", token } })
    : createElement(CopySecretView, { control: { token } })));
  if (disclosure) await click("手动复制密钥");
}
function button(text: string): HTMLButtonElement {
  const node = [...document.querySelectorAll("button")].find(node => node.textContent === text);
  if (!node) throw new Error(`Missing control: ${text}`);
  return node;
}
async function click(text: string): Promise<void> { await act(() => button(text).click()); }
function status(): string { return element('[role="status"]', HTMLElement).textContent ?? ""; }

describe("one-time secret copying", () => {
  it("renders a selectable value and truthful manual instructions without scripting", () => {
    document.body.innerHTML = renderToString(createElement(CopySecretView, { control: { token } }));
    expect(element('[data-created-token]', HTMLElement).textContent).toBe(token);
    expect(document.querySelector("button")).toBeNull();
    expect(status()).toContain("Ctrl+C");
    expect(status()).not.toContain("已复制");
  });

  it.each(["missing", "missing writer", "throw", "reject", "unconfirmed result", "getter throw"])("handles %s without claiming a copy or making a hidden secret node", async (failure) => {
    if (failure === "getter throw") Object.defineProperty(navigator, "clipboard", { configurable: true, get() { throw new Error("unavailable"); } });
    else clipboard(failure === "missing" ? undefined : failure === "missing writer" ? {} : { writeText: failure === "throw" ? () => { throw new Error("blocked"); }
      : failure === "reject" ? () => Promise.reject(new Error("blocked")) : () => undefined });
    await mount(); await click("复制密钥");
    expect(status()).toContain("未能复制");
    expect(document.body.textContent).not.toContain("已复制");
    await click("选择密钥");
    expect(document.getSelection()?.toString()).toBe(token);
    expect(document.activeElement).toBe(element('[data-created-token]', HTMLElement));
    expect(status()).toContain("已选择密钥，请手动复制");
    expect(document.querySelectorAll('[data-created-token]')).toHaveLength(1);
    expect(document.querySelector("textarea,input")).toBeNull();
    await click("取消选择");
    expect(document.getSelection()?.toString()).toBe("");
    expect(document.activeElement).toBe(button("选择密钥"));
  });

  it.each([false, true])("confirms the resolved write contract for the shared disclosure=%s view", async (disclosure) => {
    const writeText = vi.fn().mockResolvedValue(undefined); clipboard({ writeText });
    await mount(disclosure); await click("复制密钥");
    expect(writeText).toHaveBeenCalledExactlyOnceWith(token);
    expect(status()).toContain("已复制到系统剪贴板");
    expect(document.activeElement).toBe(button("已复制"));
  });

  it("does not duplicate a pending call or let its result steal manual-selection focus", async () => {
    let resolve!: () => void;
    const writeText = vi.fn(() => new Promise<void>(done => { resolve = done; })); clipboard({ writeText });
    await mount(); await click("复制密钥"); await click("正在复制…");
    expect(writeText).toHaveBeenCalledOnce();
    await click("选择密钥"); await act(() => resolve());
    expect(status()).toContain("已选择密钥，请手动复制");
    expect(document.getSelection()?.toString()).toBe(token);
    expect(document.activeElement).toBe(element('[data-created-token]', HTMLElement));
    await act(() => element('[data-created-token]', HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.getSelection()?.toString()).toBe("");
    expect(document.activeElement).toBe(button("选择密钥"));
  });

  it("does not restore focus after the user moves elsewhere during a pending copy", async () => {
    let resolve!: () => void;
    clipboard({ writeText: () => new Promise<void>(done => { resolve = done; }) });
    await mount(); await click("复制密钥");
    const elsewhere = element("#elsewhere", HTMLButtonElement); elsewhere.focus();
    await act(() => resolve());
    expect(status()).toContain("已复制到系统剪贴板");
    expect(document.activeElement).toBe(elsewhere);
  });

  it.each(["resolve", "reject"])("ignores late %s after unmount and releases selection", async (result) => {
    let finish!: () => void;
    clipboard({ writeText: () => new Promise<void>((resolve, reject) => { finish = result === "resolve" ? resolve : () => reject(new Error("denied")); }) });
    await mount(); await click("复制密钥"); await click("选择密钥");
    await act(() => root?.unmount()); root = null;
    expect(document.getSelection()?.toString()).toBe("");
    await act(() => finish());
    expect(document.body.textContent).not.toContain(token);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("closing an administrator disclosure releases its selected value", async () => {
    await mount(true); await click("选择密钥"); await click("手动复制密钥");
    expect(document.getSelection()?.toString()).toBe("");
    expect(document.querySelector('[data-created-token]')).toBeNull();
  });
});
