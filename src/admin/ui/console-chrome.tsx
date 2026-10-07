import type { ReactNode } from "react";
import { consoleTheme } from "../generated/console-styles";
import { AccountMenuIsland } from "./islands";
import { Sidebar, SidebarContent, SidebarHeader, SidebarFooter } from "./components/sidebar";

/** Installation metadata is identical for every authenticated role. */
export function AppHead() {
  return <><meta name="theme-color" content={consoleTheme.light.background} media="(prefers-color-scheme: light)" /><meta name="theme-color" content={consoleTheme.dark.background} media="(prefers-color-scheme: dark)" /><meta name="apple-mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-title" content="Agency Relay" /><meta name="apple-mobile-web-app-status-bar-style" content="default" /><link rel="manifest" href="/admin/app.webmanifest" crossOrigin="use-credentials" /><link rel="icon" href="/admin/app-icon-192.png" type="image/png" /><link rel="apple-touch-icon" href="/admin/app-icon-192.png" /></>;
}
export function ConsoleHeader({email}: {readonly email?: string; readonly role?: "admin" | "user"; readonly actorId?: string | null}) {
  return email ? <header className="site-header console-status-header"><span className="console-page-status" data-console-status="" role="status" aria-live="polite" hidden/></header> : <header className="site-header"><ConsoleBrand/></header>;
}
function ConsoleBrand() { return <a className="brand" href="/" aria-label="Agency Relay 首页"><span className="brand-mark">A</span><strong>Agency Relay</strong></a>; }
/** Native checkbox disclosure works before JavaScript, with one set of links.
 * The panel is in document flow, so neither keyboard nor enlarged text is trapped. */
export function ConsoleNavigation({member = false, current, children, email, role, actorId}: {readonly member?: boolean; readonly current: string; readonly children: ReactNode; readonly email?: string; readonly role?: "admin" | "user"; readonly actorId?: string | null}) {
  return <Sidebar collapsible="none" className="nav-rail" role="navigation" aria-label={member ? "成员页面" : "控制台页面"} data-member-nav={member ? "true" : undefined} data-dashboard-nav={member ? undefined : "vertical"} data-nav-grouped={member ? undefined : "workspace-resources-observation-advanced"}>
    <SidebarHeader className="console-nav-brand"><ConsoleBrand/></SidebarHeader>
    <input className="nav-toggle" type="checkbox" id="console-navigation-toggle" aria-label="显示导航" aria-controls="console-navigation-items" />
    <label className="nav-toggle-label" htmlFor="console-navigation-toggle"><span>导航</span><strong>{current}</strong><span className="nav-toggle-indicator" aria-hidden="true">＋</span></label>
    <SidebarContent className="console-navigation-items" id="console-navigation-items">{children}</SidebarContent>
    {email ? <SidebarFooter className="console-nav-account"><div className="identity" data-console-actor-id={actorId ?? undefined} data-console-email={email} data-console-role={role}><div className="identity-person"><AccountMenuIsland control={{email,role:role ?? "user"}}/></div></div></SidebarFooter> : null}
  </Sidebar>;
}
