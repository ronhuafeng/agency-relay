import { formatNumber, formatOperatorInstantOrDash, presentText } from "../../format";
import { VisibleRowFilter } from "../chrome";
import { Badge } from "../components/badge";
import { InfoPopover } from "../components/info-popover";
import { Table,TableHeader,TableBody,TableRow,TableHead,TableCell } from "../components/table";
import { useEffect, useRef, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/tabs";
import { useEnhanced } from "../use-enhanced";
import { RoutesIsland } from "../islands";
import { initializeVisibleRowFilters } from "../../client/filters";
import { profileForSurfaceGrant } from "../../../plans/execution-plans";

export interface RouteRow {
  readonly id: string;
  readonly hostname: string;
  readonly method: string;
  readonly path: string;
  readonly grant: string;
  readonly slot: string;
  readonly last_success_at: string | null;
  readonly last_failure_at: string | null;
}

function healthOf(route: RouteRow): "ok" | "warn" | "neutral" {
  if (route.last_failure_at && (!route.last_success_at || route.last_failure_at > route.last_success_at)) return "warn";
  if (route.last_success_at) return "ok";
  return "neutral";
}

function healthLabel(health: "ok" | "warn" | "neutral"): string {
  if (health === "ok") return "最近成功";
  if (health === "warn") return "最近失败";
  return "尚无记录";
}

function grantLabel(grant: string): string {
  return profileForSurfaceGrant(grant)?.clientLabel ?? "未记录授权";
}

function slotLabel(slot: string): string {
  if (slot === "chatgpt_production") return "ChatGPT";
  if (slot === "grok_production") return "Grok";
  return "未记录账号";
}

function RouteList({ hostname, routes, hostIndex, tabbed = false }: { readonly hostname: string; readonly routes: readonly RouteRow[]; readonly hostIndex: number; readonly tabbed?: boolean }) {
  const headingId = `route-host-${hostIndex}-title`;
  return (
    <section className="panel surface-host" data-surface-hostname={hostname} aria-labelledby={headingId}>
      <div className="panel-head">
        <div className="route-host-identity"><h2 id={headingId} className={tabbed ? "sr-only" : undefined}>{grantLabel(routes[0]?.grant ?? "")}</h2><code>{presentText(hostname)}</code></div>
      </div>
      <VisibleRowFilter label={`${hostname} 上的路由`} placeholder="过滤路由" countLabel={`${formatNumber(routes.length)} 条`} rowCount={routes.length} shownRowsOnly hideCount>
        <div className="route-table"><Table scrollLabel={`${hostname} 上的路由`} role="table" aria-label={`${hostname} 上的路由`}><TableHeader role="rowgroup"><TableRow role="row"><TableHead scope="col">方法</TableHead><TableHead scope="col">请求路径</TableHead><TableHead scope="col">服务</TableHead><TableHead scope="col">最近结果</TableHead><TableHead scope="col"><span className="sr-only">详情</span></TableHead></TableRow></TableHeader><TableBody role="rowgroup">
          {routes.map((route) => {
            const health = healthOf(route);
            return (
              <TableRow role="row" key={route.id} data-route-id={route.id} data-route-health={health}>
                <TableCell role="cell"><code className="route-method">{presentText(route.method)}</code></TableCell><TableCell role="cell"><code className="route-path">{presentText(route.path)}</code></TableCell><TableCell role="cell">{grantLabel(route.grant)}</TableCell>
                <TableCell role="cell"><Badge className={`tone-badge tone-${health === "warn" ? "bad" : health}`}>{healthLabel(health)}</Badge></TableCell>
                <TableCell role="cell"><InfoPopover id={`route-info-${hostIndex}-${encodeURIComponent(route.id)}`} label="请求与授权详情" iconOnly>
                  <dl className="admin-facts">
                    <div><dt>最近失败</dt><dd><time dateTime={route.last_failure_at ?? undefined} title={route.last_failure_at ?? undefined}>{formatOperatorInstantOrDash(route.last_failure_at)}</time></dd></div>
                    <div><dt>最近成功</dt><dd><time dateTime={route.last_success_at ?? undefined} title={route.last_success_at ?? undefined}>{formatOperatorInstantOrDash(route.last_success_at)}</time></dd></div>
                    <div><dt>需要的授权</dt><dd>{grantLabel(route.grant)}</dd></div>
                    <div><dt>使用的上游账号</dt><dd>{slotLabel(route.slot)}</dd></div>
                  </dl>
                </InfoPopover></TableCell>
              </TableRow>
            );
          })}
        </TableBody></Table></div>
      </VisibleRowFilter>
    </section>
  );
}

export function readRoutes(value: unknown): readonly RouteRow[] | null {
  return Array.isArray(value) && value.every(row => row && ["id", "hostname", "method", "path", "grant", "slot"].every(field => typeof row[field] === "string") && ["last_success_at", "last_failure_at"].every(field => row[field] === null || typeof row[field] === "string")) ? value : null;
}
export function RoutesPage({routes}: {readonly routes: readonly RouteRow[]}) { return <RoutesIsland routes={routes}/>; }
export function RoutesView({ routes }: { readonly routes: readonly RouteRow[] }) {
  const enhanced = useEnhanced(); const [selected, setSelected] = useState(""); const root = useRef<HTMLElement | null>(null);
  useEffect(() => {if (root.current) initializeVisibleRowFilters(root.current);}, [enhanced]);
  const byHost = new Map<string, RouteRow[]>();
  for (const route of routes) {
    const list = byHost.get(route.hostname) ?? [];
    list.push(route);
    byHost.set(route.hostname, list);
  }
  const hosts = [...byHost.keys()].sort((a, b) => a.localeCompare(b));
  useEffect(() => {
    const restore = (): void => {const match = /^#route-host-(\d+)-title$/.exec(location.hash); setSelected(hosts[Number(match?.[1] ?? 0)] ?? hosts[0] ?? "");};
    restore(); window.addEventListener("hashchange", restore);
    return () => window.removeEventListener("hashchange", restore);
  }, [hosts.join("|")]);
  const active = hosts.includes(selected) ? selected : hosts[0];
  if (enhanced && hosts.length > 1) return <section ref={root} aria-label="路由" className="route-catalog" data-surfaces-grouped="hostname" data-view-role="routes"><Tabs value={active} onValueChange={host => {setSelected(host); history.replaceState(history.state,"",`#route-host-${hosts.indexOf(host)}-title`);}}><TabsList variant="line" aria-label="路由服务">{hosts.map(host => <TabsTrigger key={host} value={host}>{grantLabel(byHost.get(host)?.[0]?.grant ?? "")}</TabsTrigger>)}</TabsList>{hosts.map((hostname,hostIndex)=><TabsContent key={hostname} value={hostname} forceMount hidden={hostname !== active}><RouteList hostname={hostname} routes={byHost.get(hostname) ?? []} hostIndex={hostIndex} tabbed/></TabsContent>)}</Tabs></section>;
  return (
    <section ref={root} aria-label="路由" className="view-stack route-catalog" data-surfaces-grouped="hostname" data-view-role="routes">
      {hosts.length > 1 ? <nav className="section-links route-host-links" aria-label="路由主机">{hosts.map((hostname, index) => <a key={hostname} href={`#route-host-${index}-title`}>{grantLabel(byHost.get(hostname)?.[0]?.grant ?? "")} <span className="sr-only">{hostname}</span></a>)}</nav> : null}
      {hosts.length === 0
        ? <p className="empty">还没有路由。</p>
        : hosts.map((hostname, hostIndex) => <RouteList key={hostname} hostname={hostname} routes={byHost.get(hostname) ?? []} hostIndex={hostIndex} />)}
    </section>
  );
}
