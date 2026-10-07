import { initializeRecovery } from "./recovery";
import { useEffect, useRef, useState } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "../ui/components/alert-dialog";
import { createDrafts } from "./drafts";
import { createNavigation } from "./navigation";
import { initializeBackgroundRefresh } from "./background-refresh";
import { initializeCredentialStatus } from "./credential-status";
import { initializeMutations } from "./mutations";
import { initializeMemberMutations } from "./member-mutations";
import { initializeMemberKeyRows, disposeMemberKeyRows } from "./member-key-rows";
import { initializeVisibleRowFilters } from "./filters";
import { initializeSetup, initializeView } from "./setup";
import { AccessChoiceView, AddAccountView, MemberKeyForm } from "../ui/forms";
import { CapabilityComparison } from "../ui/capabilities";
import { UsageReport } from "../ui/usage-report";
import { UsageComparison, readUsageComparison } from "../ui/usage-comparison";
import { CopySecretView, DisclosureView } from "../ui/secrets";
import { readAccessChoice, readAddAccount, readCapabilityComparison, readCopySecret, readDisclosure, readMemberKeyForm, readUsageReport } from "../ui/models";
import { AccountMenuView, readAccountMenu } from "../ui/account-menu";
import { SetupFilesView, readSetupFiles } from "../ui/setup-files";
import { SetupWorkbenchView, readSetupWorkbench } from "../ui/setup-workbench";
import { RequestFiltersView, readRequestFilters } from "../ui/request-filters";
import { TaskEditorView, readTaskEditor } from "../ui/task-editor";
import { RoutesView, readRoutes } from "../ui/pages/routes";
import { CreditTableView, readCreditTable } from "../ui/credit-table";
import { PeopleCreateView, readPeopleCreate } from "../ui/people-create";

interface PendingConfirmation {
  form: HTMLFormElement;
  submitter: HTMLElement | null;
  message: string;
  label: string;
  destructive: boolean;
}

function hideFallbacks(root: ParentNode): void {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-confirmation-fallback]"));
  if (root instanceof HTMLElement && root.matches("[data-confirmation-fallback]")) nodes.push(root);
  nodes.forEach((node) => {
    node.hidden = true;
    node.querySelector("input")?.setAttribute("disabled", "");
  });
}

function ConfirmDialog() {
  const returnFocus = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  useEffect(() => {
    hideFallbacks(document);
    const onSubmit = (event: Event): void => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.matches("form[data-confirmation]")) return;
      if (document.documentElement.hasAttribute("data-console-authority-pending")
        || document.querySelector('main[data-mutation-pending="true"],main form[aria-busy="true"],main[data-member-mutation-blocked="true"],main[data-dashboard-mutation-blocked="true"]')) {
        delete form.dataset.confirmed;
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (form.dataset.confirmed === "true") {
        delete form.dataset.confirmed;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const submitter = event instanceof SubmitEvent && event.submitter instanceof HTMLElement ? event.submitter : null;
      returnFocus.current = submitter;
      setPending({
        form,
        submitter,
        message: (form.dataset.confirmation ?? "")
          + (form.hasAttribute("data-confirm-email") ? ` 新邮箱：${new FormData(form).get("email") ?? ""}` : "")
          + (form.hasAttribute("data-confirm-service-owner") ? ` 新的管理人：${form.querySelector<HTMLSelectElement>('select[name="owner_selection"]')?.selectedOptions[0]?.textContent ?? "未选择"}` : "")
          + (form.hasAttribute("data-confirm-credential") ? ` 选择的连接：${form.querySelector<HTMLSelectElement>('select[name="credential_account_id"],select[name="replacement_account_id"]')?.selectedOptions[0]?.textContent ?? "未选择"}` : ""),
        label: submitter?.dataset.confirmLabel || submitter?.textContent?.trim() || "确认",
        destructive: submitter?.dataset.variant === "destructive"
      });
    };
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("submit", onSubmit, true);
    };
  }, []);

  const close = (): void => setPending(null);
  const confirm = (): void => {
    const current = pending;
    setPending(null);
    if (!current?.form.isConnected) return;
    current.form.dataset.confirmed = "true";
    current.form.requestSubmit(current.submitter instanceof HTMLButtonElement ? current.submitter : undefined);
  };

  return <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) close(); }}>
    <AlertDialogContent data-action-confirmation="" onCloseAutoFocus={(event) => {
      event.preventDefault();
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    }}>
      <AlertDialogHeader>
        <AlertDialogTitle>请确认</AlertDialogTitle>
        <AlertDialogDescription data-tone={pending?.destructive ? "bad" : undefined}>{pending?.message}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel className="confirmation-cancel" autoFocus>取消</AlertDialogCancel>
        <AlertDialogAction className="confirmation-submit" variant={pending?.destructive ? "destructive" : "default"} onClick={confirm}>{pending?.label ?? "确认"}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

const hydrated = new Map<HTMLElement, Root>();
const consumed = new WeakSet<HTMLScriptElement>();

function hydrateControl(node: HTMLScriptElement): void {
  if (consumed.has(node) || !node.textContent) return;
  consumed.add(node);
  const value = parseJson(node.textContent);
  if (node.dataset.uiProps === "people-create") {
    const control = readPeopleCreate(value); const root = document.getElementById("people-create-root");
    if (control && root && !hydrated.has(root)) hydrated.set(root, hydrateRoot(root, <PeopleCreateView control={control}/>));
    return;
  }
  if (node.dataset.uiProps === "credit-table") {
    const rows = readCreditTable(value); const root = document.getElementById("person-credit-table-root");
    if (rows && root && !hydrated.has(root)) hydrated.set(root, hydrateRoot(root, <CreditTableView rows={rows}/>));
    return;
  }
  if (node.dataset.uiProps === "task-editor") {
    const control = readTaskEditor(value); const root = control && document.getElementById(`${control.id}-root`);
    if (control && root && !hydrated.has(root)) hydrated.set(root, hydrateRoot(root, <TaskEditorView control={control}/>));
    return;
  }
  if (node.dataset.uiProps === "routes") {
    const routes = readRoutes(value); const root = document.getElementById("routes-root");
    if (routes && root && !hydrated.has(root)) hydrated.set(root, hydrateRoot(root, <RoutesView routes={routes}/>));
    return;
  }
  if (node.dataset.uiProps === "usage-comparison") {
    const control = readUsageComparison(value); const root = control && document.getElementById(`${control.id}-root`);
    if (!control || !root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <UsageComparison control={control}/>));
    return;
  }
  if (node.dataset.uiProps === "request-filters") {
    const control = readRequestFilters(value); const root = document.getElementById("request-filters-root");
    if (!control || !root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <RequestFiltersView control={control}/>));
    return;
  }
  if (node.dataset.uiProps === "account-menu") {
    const control = readAccountMenu(value); const root = document.getElementById("account-menu-root");
    if (!control || !root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <AccountMenuView control={control}/>));
    return;
  }
  if (node.dataset.uiProps === "setup-files") {
    const control = readSetupFiles(value); const root = control && document.getElementById(`${control.id}-root`);
    if (!control || !root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <SetupFilesView control={control}/>));
    return;
  }
  if (node.dataset.uiProps === "setup-workbench") {
    const control = readSetupWorkbench(value); const root = control && document.getElementById(`${control.id}-root`);
    if (!control || !root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <SetupWorkbenchView control={control}/>));
    return;
  }
  if (node.dataset.uiProps === "usage-report") {
    const control = readUsageReport(value); const root = document.getElementById("usage-report");
    if (!control || !root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <UsageReport control={control} />));
    return;
  }
  if (node.dataset.uiProps === "member-key-form") {
    const model = readMemberKeyForm(value);
    const root = document.getElementById("member-key-form");
    if (!model || !root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <MemberKeyForm model={model} />));
    return;
  }
  if (node.dataset.uiProps === "capability") {
    const model = readCapabilityComparison(value);
    const root = document.getElementById("capability-comparison");
    if (!model || !root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <CapabilityComparison model={model} />));
    return;
  }
  if (node.dataset.uiProps === "disclosure") {
    const control = readDisclosure(value);
    if (!control) return;
    const root = document.getElementById(`${control.id}-root`);
    if (!root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <DisclosureView control={control} />));
    return;
  }
  if (node.dataset.uiProps === "copy-secret") {
    const control = readCopySecret(value);
    const root = document.getElementById("copy-secret-root");
    if (!control || !root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <CopySecretView control={control} />));
    return;
  }
  if (node.dataset.uiProps === "add-account") {
    const control = readAddAccount(value);
    const root = document.getElementById("add-account-root");
    if (!control || !root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <AddAccountView control={control} />));
    return;
  }
  if (node.dataset.uiProps === "access-choice") {
    const choice = readAccessChoice(value);
    if (!choice) return;
    const root = document.getElementById(`access-choice-${choice.id}-root`);
    if (!root || hydrated.has(root)) return;
    hydrated.set(root, hydrateRoot(root, <AccessChoiceView choice={choice} />));
    return;
  }

}

function prepareControls(scope: ParentNode): void {
  hideFallbacks(scope);
  const scripts = Array.from(scope.querySelectorAll<HTMLScriptElement>("script[data-ui-props]"));
  if (scope instanceof HTMLScriptElement && scope.matches("[data-ui-props]")) scripts.push(scope);
  const controls = scripts.filter(node => !consumed.has(node) && Boolean(node.textContent));
  // Integration is a browser document boundary, not a React render. Finish the
  // small islands before layout so native fallback and enhanced controls cannot
  // paint as two different task layouts during in-document navigation.
  if (controls.length) flushSync(() => controls.forEach(hydrateControl));
  initializeMemberKeyRows(scope);
}

export function mountConsoleDialog(root: Element): () => void {
  const dialog = createRoot(root); flushSync(() => dialog.render(<ConfirmDialog />));
  prepareControls(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      prepareControls(node);
    }
    for (const [element, reactRoot] of hydrated) if (!element.isConnected) { reactRoot.unmount(); hydrated.delete(element); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => { observer.disconnect(); dialog.unmount(); for (const reactRoot of hydrated.values()) reactRoot.unmount(); hydrated.clear(); };
}

function clearSecrets(): void {
  // An installed app or bfcache must not replay a one-time secret.
  for (const [element, reactRoot] of hydrated) if (element.closest("[data-one-time-key]")) { reactRoot.unmount(); hydrated.delete(element); }
  document.querySelectorAll("[data-one-time-key]").forEach((node) => node.remove());
  document.querySelectorAll<HTMLInputElement>('input[type="password"],input[name="callback_url"]').forEach((input) => { input.value = ""; });
  document.querySelectorAll<HTMLScriptElement>('script[data-ui-props="copy-secret"],script[data-ui-props="disclosure"]').forEach((node) => { node.textContent = ""; });
}
const mount = document.querySelector("#console-dialog-root");
if (mount) {
  const unmount = mountConsoleDialog(mount);
  let stop = (): void => {};
  initializeSetup();
  const initialize = (root: ParentNode): void => { prepareControls(root); initializeVisibleRowFilters(root); initializeView(root); };
  initialize(document);
  let acceptBackground = (doc: Document): void => {
    const next = doc.querySelector(".shell"); const current = document.querySelector(".shell");
    if (!next || !current) return;
    current.replaceWith(next); document.title = doc.title;
    const header = document.querySelector(".site-header"); const nextHeader = doc.querySelector(".site-header");
    if (header && nextHeader) header.replaceWith(nextHeader);
    initialize(next);
  };
  if (document.querySelector('.shell[data-dashboard-nav]')) {
    const navigation = createNavigation(initialize, createDrafts());
    const stopMutations = initializeMutations(navigation);
    acceptBackground = navigation.acceptBackground;
    stop = () => { stopMutations(); navigation.dispose(); };
  } else if (document.querySelector("[data-member-nav]")) stop = initializeMemberMutations();
  const stopBackground = initializeBackgroundRefresh(doc => acceptBackground(doc));
  const stopCredentials = initializeCredentialStatus();
  initializeRecovery(() => { stopCredentials(); stopBackground(); stop(); disposeMemberKeyRows(); clearSecrets(); unmount(); });
  // Recovery captures the safe GET and known outcome before this independent
  // one-time cleanup removes the result marker. Neither handler replays a POST.
  window.addEventListener("pagehide", clearSecrets);
  if (document.querySelector('link[rel="manifest"]') && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/admin/app-worker.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  }
}
