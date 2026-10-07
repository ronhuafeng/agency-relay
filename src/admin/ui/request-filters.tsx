import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./components/button";
import { Input } from "./components/input";
import { NativeSelect } from "./components/native-select";
import { Field, FieldLabel } from "./components/field";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/collapsible";
import { useEnhanced } from "./use-enhanced";
import { InfoPopover } from "./components/info-popover";

export interface RequestFiltersControl {
  readonly action: string;
  readonly query: {readonly from: string; readonly to: string; readonly plan: string; readonly user: string; readonly result: string; readonly request: string};
  readonly services: readonly {readonly id: string; readonly label: string}[];
  readonly retentionDays: number | null;
}
export function readRequestFilters(value: unknown): RequestFiltersControl | null {
  if (!value || typeof value !== "object" || !("action" in value) || typeof value.action !== "string"
    || !("query" in value) || !value.query || typeof value.query !== "object"
    || !("services" in value) || !Array.isArray(value.services)
    || !("retentionDays" in value) || value.retentionDays !== null && typeof value.retentionDays !== "number") return null;
  const q = value.query as Record<string, unknown>;
  if (["from", "to", "plan", "user", "result", "request"].some(field => typeof q[field] !== "string")) return null;
  if (q.result !== "" && q.result !== "ok" && q.result !== "error" && q.result !== "unknown") return null;
  const services: {id: string; label: string}[] = [];
  for (const service of value.services) {
    if (!service || typeof service !== "object" || typeof service.id !== "string" || typeof service.label !== "string") return null;
    services.push({id: service.id, label: service.label});
  }
  return {action: value.action, services, retentionDays: value.retentionDays, query: {from:q.from as string,to:q.to as string,plan:q.plan as string,user:q.user as string,result:q.result,request:q.request as string}};
}

export function RequestScope({retentionDays, id = "request-history-scope"}: {readonly retentionDays: number | null; readonly id?: string}) {
  return <InfoPopover id={id} label="记录范围" iconOnly><p>仅显示当前仍保留的请求元数据{retentionDays === null ? "；保留配置暂时无法确认" : `；保留 ${retentionDays} 天`}。并非每次入口拒绝都采集，旧记录可能已清理。</p><p>用量报告和管理记录分别保存。历史成功不代表当前服务健康。</p></InfoPopover>;
}

export function RequestFiltersView({control}: {readonly control: RequestFiltersControl}) {
  const enhanced = useEnhanced();
  const q = control.query;
  const [expanded, setExpanded] = useState(Boolean(q.user || q.request));
  const form = useRef<HTMLFormElement>(null);
  const exactCount = Number(Boolean(q.user)) + Number(Boolean(q.request));
  const filtered = Boolean(q.from || q.to || q.plan || q.user || q.result || q.request);
  useEffect(() => {
    const current = form.current;
    if (!current) return;
    const restore = () => {
      if (new FormData(current).get("audit_user") || new FormData(current).get("audit_request")) setExpanded(true);
    };
    current.addEventListener("console:restore", restore);
    return () => current.removeEventListener("console:restore", restore);
  }, []);
  return <form ref={form} method="get" action={control.action} data-dashboard-search="" data-search-anchor="request-history" className="board-form request-filters" aria-label="筛选请求记录">
    <input type="hidden" name="view" value="audit" />
    <Collapsible open={!enhanced || expanded} onOpenChange={setExpanded}>
      <div className="request-filter-primary">
        <Field><FieldLabel htmlFor="request-from">开始日期（UTC）</FieldLabel><Input id="request-from" type="date" name="audit_from" defaultValue={q.from} /></Field>
        <Field><FieldLabel htmlFor="request-to">结束日期（UTC）</FieldLabel><Input id="request-to" type="date" name="audit_to" defaultValue={q.to} /></Field>
        <Field><FieldLabel htmlFor="request-plan">服务与路由</FieldLabel><NativeSelect id="request-plan" name="audit_plan" defaultValue={q.plan}>
          <option value="">全部服务</option>
          {q.plan && !control.services.some(service => service.id === q.plan) ? <option value={q.plan}>{q.plan}（历史标识）</option> : null}
          {control.services.map(service => <option key={service.id} value={service.id}>{service.label}</option>)}
        </NativeSelect></Field>
        <Field><FieldLabel htmlFor="request-result">结果</FieldLabel><NativeSelect id="request-result" name="audit_result" defaultValue={q.result}><option value="">全部结果</option><option value="ok">成功</option><option value="error">失败</option><option value="unknown">未识别</option></NativeSelect></Field>
      </div>
      <div className="request-filter-actions">
        {enhanced ? <CollapsibleTrigger asChild><Button type="button" variant="outline">精确定位{exactCount ? ` · ${exactCount}` : ""}<ChevronDown className="ui-icon" aria-hidden="true" /></Button></CollapsibleTrigger> : null}
        <Button type="submit">筛选请求</Button>
        {filtered ? <Button asChild variant="ghost"><a data-dashboard-link="" href="?view=audit#request-history">清除筛选</a></Button> : null}
        <RequestScope retentionDays={control.retentionDays}/>
      </div>
      <CollapsibleContent forceMount hidden={enhanced && !expanded} className="request-exact-filters">
        <Field><FieldLabel htmlFor="request-person">成员</FieldLabel><Input id="request-person" name="audit_user" placeholder="邮箱或成员 ID · 精确匹配" defaultValue={q.user} maxLength={254} /></Field>
        <Field><FieldLabel htmlFor="request-correlation">请求 ID</FieldLabel><Input id="request-correlation" name="audit_request" placeholder="精确匹配" defaultValue={q.request} maxLength={128} autoComplete="off" /></Field>
      </CollapsibleContent>
    </Collapsible>
  </form>;
}
