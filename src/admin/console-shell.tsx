import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { consoleStyles } from "./generated/console-styles";
import { AppHead, ConsoleHeader, ConsoleNavigation } from "./ui/console-chrome";
import { SidebarProvider } from "./ui/components/sidebar";

interface ConsoleDocumentInput {
  readonly title: string;
  readonly navigationUrl?: string;
  readonly readUrl?: string;
  readonly dataRevision?: string;
  readonly view?: string;
  readonly main: ReactNode;
  readonly email?: string;
  readonly actorId?: string;
  readonly nav?: ReactNode;
  readonly confirm?: boolean;
  readonly nonce?: string;
  readonly role?: "admin" | "user";
  readonly current?: string;
  readonly switches?: readonly {readonly href: string; readonly label: string}[];
  readonly appEnabled?: boolean;
  readonly extra?: ReactNode;
}

/** Shared document chrome for sign-in, member pages and read errors. */
export function consoleDocument(input: ConsoleDocumentInput): string {
  return "<!doctype html>" + renderToString(
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex,nofollow" />
        <title>{input.title}</title>
        {input.appEnabled ? <AppHead /> : null}
        <style nonce={input.nonce}>{consoleStyles}</style>
      </head>
      <body className="console-simple">
        <a className="skip-link" href="#content">跳到正文</a>
        <ConsoleHeader email={input.email} role={input.role} actorId={input.actorId} />
        <SidebarProvider className="shell" data-dashboard-nav={input.navigationUrl ? "vertical" : undefined}>
          {input.nav ? <ConsoleNavigation member current={input.current ?? input.title} email={input.email} role={input.role} actorId={input.actorId} switches={input.switches}><div className="primary-nav">{input.nav}</div></ConsoleNavigation> : null}
          <main id="content" tabIndex={-1} data-dashboard-view={input.view ?? (input.navigationUrl ? "usage" : undefined)} data-dashboard-url={input.navigationUrl} data-console-read-url={input.readUrl} data-console-revision={input.dataRevision}>
            {input.navigationUrl ? <div className="dashboard-notice" data-dashboard-notice="" role="status" aria-live="polite" aria-atomic="true" hidden><span data-notice-message=""/><a hidden>打开页面</a></div> : null}
            {input.main}</main>
        </SidebarProvider>
        {input.extra}
        {input.confirm ? (
          <>
            <div id="console-dialog-root" />
            <script type="module" src="/admin/console.js" nonce={input.nonce} />
          </>
        ) : null}
      </body>
    </html>
  );
}
