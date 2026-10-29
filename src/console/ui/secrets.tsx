import { useEffect, useRef, useState } from "react";
import { Button } from "./components/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./components/collapsible";
import { useEnhanced } from "./use-enhanced";
import type { CopySecretControl, DisclosureControl } from "./models";

async function writeClipboard(value: string): Promise<void> {
  // Keep the call in the activation handler, but turn synchronous API/getter
  // failures into rejections too. Never infer success from selecting text.
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== "function") throw new Error("clipboard unavailable");
  const result = clipboard.writeText(value);
  if (!result || typeof result.then !== "function") throw new Error("clipboard result unavailable");
  await result;
}

function clearSelection(node: HTMLElement | null): void {
  const selection = node?.ownerDocument.getSelection();
  if (selection && (node?.contains(selection.anchorNode) || node?.contains(selection.focusNode))) selection.removeAllRanges();
}

const instructions = "密钥只显示一次。可选择密钥后按 Ctrl+C（Mac：⌘C），或在触屏上长按选中内容并选择“复制”。";

export function CopySecretView({ control, statusId = "copy-secret-status" }: { readonly control: CopySecretControl; readonly statusId?: string }) {
  const enhanced = useEnhanced();
  const secret = useRef<HTMLElement | null>(null);
  const selectButton = useRef<HTMLButtonElement | null>(null);
  const attempt = useRef(0);
  const [state, setState] = useState<"ready" | "pending" | "copied" | "failed" | "selected">("ready");

  useEffect(() => {
    const node = secret.current;
    return () => {
      // A closed disclosure, removed result or pagehide invalidates late replies.
      ++attempt.current;
      clearSelection(node);
    };
  }, [control.token]);

  const cancelSelection = (): void => {
    ++attempt.current;
    clearSelection(secret.current);
    setState("ready");
    selectButton.current?.focus({ preventScroll: true });
  };

  return (
    <div className="secret-copy grid min-w-0 gap-3">
      <code ref={secret} className="secret block min-w-0 break-all"
        role="textbox" aria-label="一次性密钥" aria-readonly="true" aria-describedby={statusId} tabIndex={0}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelSelection(); } }} data-created-token="true"
      >{control.token}</code>
      {enhanced ? <div className="flex flex-wrap gap-3">
        <Button type="button" aria-disabled={state === "pending"}
          onClick={(event) => {
            if (state === "pending") return;
            const trigger = event.currentTarget;
            const node = secret.current;
            const current = ++attempt.current;
            clearSelection(node);
            trigger.focus({ preventScroll: true });
            setState("pending");
            void writeClipboard(control.token).then(
              () => {
                if (attempt.current !== current || !node?.isConnected) return;
                setState("copied");
                // Do not steal focus if the user moved on while permission was pending.
                if (document.activeElement === trigger || document.activeElement === document.body) trigger.focus({ preventScroll: true });
              },
              () => { if (attempt.current === current && node?.isConnected) setState("failed"); }
            );
          }}
        >{state === "pending" ? "正在复制…" : state === "copied" ? "已复制" : "复制密钥"}</Button>
        <Button ref={selectButton} type="button" variant="outline" onClick={() => {
          ++attempt.current;
          const node = secret.current;
          if (!node) return;
          // Select the displayed value itself: no hidden textarea or secret copy.
          node.focus({ preventScroll: true });
          const selection = node.ownerDocument.getSelection();
          const range = node.ownerDocument.createRange();
          range.selectNodeContents(node);
          selection?.removeAllRanges();
          selection?.addRange(range);
          setState(selection?.toString() === control.token ? "selected" : "failed");
        }}>选择密钥</Button>
        {state === "selected" ? <Button type="button" variant="ghost" onClick={cancelSelection}>取消选择</Button> : null}
      </div> : null}
      <p id={statusId} role="status" aria-live="polite" aria-atomic="true">
        {state === "copied" ? "已复制到系统剪贴板。网页无法在离页后清除系统剪贴板，请妥善保管。"
          : state === "failed" ? `未能复制到剪贴板。请选择密钥后手动复制，无需创建新密钥。${instructions}`
            : state === "selected" ? `已选择密钥，请手动复制。${instructions}`
              : state === "pending" ? "正在请求写入剪贴板；也可直接选择密钥手动复制。" : instructions}
      </p>
    </div>
  );
}

export function DisclosureView({ control }: { readonly control: DisclosureControl }) {
  const enhanced = useEnhanced();
  if (!enhanced) return <details className="account-details"><summary>{control.title}</summary><CopySecretView control={control} statusId={`${control.id}-copy-status`} /></details>;
  return (
    <Collapsible className="account-details radix-collapsible">
      <CollapsibleTrigger className="radix-collapsible-trigger">{control.title}</CollapsibleTrigger>
      <CollapsibleContent className="radix-collapsible-content">
        <CopySecretView control={control} statusId={`${control.id}-copy-status`} />
      </CollapsibleContent>
    </Collapsible>
  );
}
