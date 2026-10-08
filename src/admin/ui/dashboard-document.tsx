import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { dashboardViewTitle, DASHBOARD_VIEW_DEFINITIONS, type AdminDashboardPageModelBase, type AdminDashboardPageModel } from "../dashboard-data";
import { consoleStyles } from "../generated/console-styles";
import { buildClientSetupTemplates, CLIENT_SETUP_TOKEN_PLACEHOLDER } from "../client-setup";
import { HomePage } from "./pages/home";
import { AccountsPage } from "./pages/accounts";
import { RequestHistory } from "./pages/request-history";
import { UsagePage } from "./pages/usage";
import { RoutesPage } from "./pages/routes";
import { QuotasPage, ControlAuditPage } from "./pages/organization";
import { SetupPage } from "./pages/setup";
import { PeoplePage } from "./pages/people";
import { MutationNotice } from "./mutation-notice";
import { Button } from "./components/button";
import { Icon } from "./icon";
import { viewHref } from "./href";
import { AppHead, ConsoleHeader, ConsoleNavigation } from "./console-chrome";
import { memberHref } from "../member-href";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider } from "./components/sidebar";
function DashboardPage({model}: {readonly model: AdminDashboardPageModel}) {
  switch (model.view) {
    case "overview": return <HomePage model={model} />;
    case "credentials": return <AccountsPage model={model} />;
    case "access": return <PeoplePage model={model} />;
    case "setup": return <SetupPage model={model} />;
    case "audit": return <RequestHistory model={model.history} />;
    case "usage": return <UsagePage model={model} />;
    case "surfaces": return <RoutesPage routes={model.routes} />;
    case "quotas": return <QuotasPage defaults={model.defaults} />;
    case "control-audit": return <ControlAuditPage rows={model.rows} truncated={model.truncated} />;
  }
}
export function DashboardContent({model}: {readonly model: AdminDashboardPageModel}) {
  const noticeOwnedByPage = model.view === "setup";
  return <>{!noticeOwnedByPage ? <MutationNotice flash={model.mutationFlash} /> : null}<DashboardPage model={model} /></>;
}
function Navigation({model}: {readonly model: AdminDashboardPageModelBase}) {
  return <ConsoleNavigation current={dashboardViewTitle(model.view)} email={model.operatorLabel} role="admin" actorId={model.operatorId} switches={[{href: memberHref("home"), label: "我的空间"}]}>{(["workspace", "resources", "observation", "advanced"] as const).map((group) => <SidebarGroup key={group} className="console-nav-group" data-nav-group={group}>
    <SidebarMenu>{DASHBOARD_VIEW_DEFINITIONS.filter((item) => item.group === group).map((item) => <SidebarMenuItem key={item.key}><SidebarMenuButton asChild isActive={item.key === model.view}><a href={viewHref(item.key, model.range.key)} data-dashboard-link="" aria-current={item.key === model.view ? "page" : undefined}><Icon name={item.key} /><span>{item.title}</span></a></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
  </SidebarGroup>)}</ConsoleNavigation>;
}
function PageHeader({model}: {readonly model: AdminDashboardPageModelBase}) {
  const titles = {overview:"组织概览",credentials:"上游连接",access:"成员与服务",setup:"客户端配置",audit:"请求记录",usage:"用量报告",surfaces:"服务路由",quotas:"额度政策","control-audit":"管理记录"};
  return <h1 className="sr-only">{titles[model.view]}</h1>;
}
function DashboardDocument({model, nonce, children, revision}: {readonly model: AdminDashboardPageModelBase; readonly nonce: string; readonly children: ReactNode; readonly revision?: string}) {
  return <html lang="zh-CN"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" /><meta name="color-scheme" content="light dark" /><meta name="robots" content="noindex,nofollow" /><title>{model.documentTitle}</title><meta name="description" content="Agency Relay 管理控制台。" />{model.appEnabled ? <AppHead /> : null}<style nonce={nonce}>{consoleStyles}</style></head><body id="top">
    <a className="skip-link" href="#content">跳到正文</a><ConsoleHeader email={model.operatorLabel} role="admin" actorId={model.operatorId} />
    <SidebarProvider className="shell" data-dashboard-nav="vertical"><Navigation model={model} /><main id="content" tabIndex={-1} data-dashboard-view={model.view} data-dashboard-range={model.range.key} data-dashboard-url={model.canonicalUrl} data-dashboard-mutation={model.mutationFlash?.kind} data-console-read-url={revision ? model.canonicalUrl : undefined} data-console-revision={revision}><PageHeader model={model} />
      <div className="dashboard-notice" data-dashboard-notice="" role="status" aria-live="polite" aria-atomic="true" hidden><span data-notice-message="" /><a hidden>打开页面</a><Button type="button" variant="outline" hidden data-stop-waiting="true">停止等待</Button></div><div data-dashboard-panel="">{children}</div>
    </main></SidebarProvider><div id="console-dialog-root" /><script type="application/json" nonce={nonce} id="console-setup-config" dangerouslySetInnerHTML={{__html: JSON.stringify({templates: buildClientSetupTemplates(), placeholder: CLIENT_SETUP_TOKEN_PLACEHOLDER}).replaceAll("<", "\\u003c")}} /><script type="module" src="/admin/console.js" nonce={nonce} />
  </body></html>;
}
export function renderDashboardDocument(model: AdminDashboardPageModelBase, nonce: string, content: ReactNode, revision?: string): string { return '<!doctype html>'+renderToString(<DashboardDocument model={model} nonce={nonce} revision={revision}>{content}</DashboardDocument>); }
export function ReadUnavailable({url, requestId}: {readonly url: string; readonly requestId: string}) {
  return <section className="unavailable-view" data-dashboard-unavailable="" role="alert"><h2>控制台暂时打不开</h2><p>当前数据读取失败。</p><Button asChild><a href={url} data-dashboard-link="">重试</a></Button><p className="data-note">请求编号：{requestId}</p></section>;
}
