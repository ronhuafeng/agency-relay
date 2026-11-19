import type { ReactNode } from "react";
import { formatNumber, formatOperatorInstant } from "../../format";
import type { CompletionBucketPoint, CompletionTimeModel, CompletionWindow } from "../../completion-time";
import { COMPLETION_BUCKETS, COMPLETION_SAMPLE_MINIMUM } from "../../completion-time";
import type { RequestHistoryModel, RequestHistoryRecord } from "../../request-history";
import { inventoryUrl } from "../href";
import { Button } from "../components/button";
import { ChevronRight } from "lucide-react";
import { Badge } from "../components/badge";
import { Card } from "../components/card";
import { InfoPopover } from "../components/info-popover";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/table";
import { RequestFiltersIsland } from "../islands";
import { ObjectWorkspace, TaskClose } from "../task-workspace";
import { RequestScope } from "../request-filters";

function Result({ value }: { readonly value: RequestHistoryRecord["status"] }) {
  return <Badge data-tone={value === "error" ? "bad" : value === "ok" ? "ok" : undefined}>{value === "ok" ? "成功" : value === "error" ? "失败" : "未识别"}</Badge>;
}
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
function HistoryScope({ model, id = "request-history-scope" }: { readonly model: RequestHistoryModel; readonly id?: string }) {
  return <RequestScope retentionDays={model.retentionDays} id={id}/>;
}
function RequestDetail({ row, model }: { readonly row: RequestHistoryRecord; readonly model: RequestHistoryModel }) {
  return <Card role="article" data-request-detail={row.id} className="request-detail-panel">
    <header className="request-detail-head"><div><h2>{row.service}</h2><code>{row.path ?? "路径未记录"}</code></div><div className="task-head-actions"><Result value={row.status} /><TaskClose href={`${model.listUrl}#request-history`} label="收起请求详情"/></div></header>
    <dl className="request-detail-identity">
      <Fact label="成员（当前）">{row.currentEmail ?? row.userId ?? "未记录"}</Fact>
      <Fact label="密钥（当前）">{row.currentKeyName ?? (row.keyId ? "对象已删除或标签不可用" : "未记录")}</Fact>
      <Fact label="记录时间"><time dateTime={row.at} title={row.at}>{formatOperatorInstant(row.at)}</time></Fact>
    </dl>
    <section aria-label="处理结果" className="request-outcome" data-tone={row.status === "error" ? "bad" : undefined}>
      <p>{row.reason}</p>
      <Button asChild><a href={row.check.href}>{row.check.label}<ChevronRight className="ui-icon" aria-hidden="true" /></a></Button>
    </section>
    <dl className="usage-facts">
      <Fact label="上游 HTTP 状态">{row.upstreamStatus ?? "未记录"}</Fact>
      <Fact label="记录耗时">{row.latencyMs === null ? "未记录" : `${formatNumber(row.latencyMs)} ms`}</Fact>
      <Fact label="总令牌">{row.tokens === null ? "未记录" : formatNumber(row.tokens)}</Fact>
    </dl>
    <div className="usage-details request-detail-tools"><InfoPopover id="request-detail-fields" label="记录字段与当前标签">
      <p>HTTP 状态不单独证明 SSE 终止成功或 WebSocket 会话完成；未记录时也不能判断提供商是否被调用。计量缺失或观测失败不单独证明客户任务失败。</p>
      <p>检查入口显示当前状态。记录未保存阶段耗时、终止事件或完整账本，当前标签也不是历史快照。</p>
      <dl className="usage-facts">
        <Fact label="内部审计记录 ID">{row.id}</Fact>
        <Fact label="请求关联标识">{row.requestId ?? "未记录可安全展示的标识"}（不能当作唯一记录 ID）</Fact>
        <Fact label="Execution Plan">{row.plan ?? "未记录可安全展示的标识"}</Fact>
        <Fact label="规范路径（记录）">{row.path ?? "未记录可安全展示的规范路径"}</Fact>
        <Fact label="请求方法（记录）">未记录</Fact>
        <Fact label="当前目录方法">{row.catalogMethod ?? "当前目录无此项"}（当前标签，非历史快照）</Fact>
        <Fact label="服务名称">{row.service}（当前目录标签）</Fact>
        <Fact label="账号标识（记录）">{row.userId ?? "未记录"}</Fact>
        <Fact label="当前邮箱">{row.currentEmail ?? "对象已删除或标签不可用"}（非历史快照）</Fact>
        <Fact label="密钥标识（记录）">{row.keyId ?? "未记录"}</Fact>
        <Fact label="当前密钥名称">{row.currentKeyName ?? "对象已删除或标签不可用"}（非历史快照）</Fact>
        <Fact label="上游凭据标识">{row.credentialId ?? "未记录"}</Fact>
        <Fact label="安全错误码">{row.errorCode ?? (row.unrecognizedError ? "未识别，不展示原始值" : "未记录")}</Fact>
        <Fact label="总令牌">{row.tokens === null ? "未记录" : formatNumber(row.tokens)}</Fact>
        <Fact label="输入／缓存令牌">{row.inputTokens === null ? "未记录" : formatNumber(row.inputTokens)} / {row.cachedTokens === null ? "未记录" : formatNumber(row.cachedTokens)}</Fact>
        <Fact label="输出／推理令牌">{row.outputTokens === null ? "未记录" : formatNumber(row.outputTokens)} / {row.reasoningTokens === null ? "未记录" : formatNumber(row.reasoningTokens)}</Fact>
        <Fact label="上游金额原始值（ticks）">{row.costTicks === null ? "未记录" : formatNumber(row.costTicks)}（上游报告值，不是账单）</Fact>
      </dl>
    </InfoPopover><HistoryScope model={model} id="request-detail-scope"/></div>
  </Card>;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(ms >= 10_000 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}
function windowCopy(window: CompletionWindow): string {
  if (window.source === "recent") return "未选择日期，此图使用最近 24 个 UTC 小时。";
  if (window.source === "from") return "只选择了开始日期，此图从该日 00:00 UTC 起计算 48 小时。";
  if (window.source === "to") return "只选择了结束日期，此图计算到该日结束为止的 48 小时。";
  if (window.capped) return "所选 UTC 日期超过 48 小时。此图只显示其中最近的 48 小时，表格仍使用所选日期。";
  return "此图使用所选 UTC 日期内的成功记录。";
}
function CompletionChart({ model, retryHref }: { readonly model: CompletionTimeModel; readonly retryHref: string }) {
  const ready = model.state === "ready" ? model : null;
  return <section className="completion-chart" aria-label="完成时间" data-completion-chart="" data-completion-state={model.state} data-completion-reason={model.state === "not-applicable" ? model.reason : undefined} data-completion-minimum={COMPLETION_SAMPLE_MINIMUM} data-completion-window={ready?.window.source} data-completion-capped={ready ? String(ready.window.capped) : undefined} data-completion-window-start={ready?.window.start} data-completion-window-end={ready?.window.end} data-completion-plotted={ready ? String(ready.buckets.some(bucket => bucket.sufficient)) : undefined}>
    <header className="completion-chart-head"><h2>完成时间</h2><p className="completion-chart-note">纵轴是记录耗时（秒），包含约 3 秒的首事件下限，不是纯输出时间。横轴是生成令牌（输出 + 推理）。</p></header>
    {model.state === "needs-plan" ? <p className="completion-chart-note">选择一个 Responses 执行计划后才会计算。</p> : null}
    {model.state === "not-applicable" ? <p className="completion-chart-note">{model.reason === "request" ? "按精确请求标识筛选时不计算。" : "结果筛选为失败或未识别时不计算。"}</p> : null}
    {model.state === "unavailable" ? <p role="alert">暂时无法读取。<a href={retryHref}>重新读取</a></p> : null}
    {ready ? <><p className="completion-chart-note">{windowCopy(ready.window)}</p><CompletionPlot buckets={ready.buckets} /></> : null}
  </section>;
}
function CompletionPlot({ buckets }: { readonly buckets: readonly CompletionBucketPoint[] }) {
  const plotted = buckets.filter(bucket => bucket.sufficient && bucket.p90Ms !== null);
  const scale = Math.max(1, ...plotted.map(bucket => bucket.p90Ms ?? 0));
  const plotWidth = 360;
  const plotHeight = 96;
  const column = plotWidth / COMPLETION_BUCKETS.length;
  const yOf = (ms: number) => plotHeight * (1 - ms / scale);
  return <>
    {plotted.length ? <div className="completion-chart-frame"><div className="completion-chart-y" aria-hidden="true"><span>{seconds(scale)} 秒</span><span>{seconds(scale / 2)} 秒</span><span>0 秒</span></div><div><svg className="completion-plot" viewBox={`0 0 ${plotWidth} ${plotHeight}`} preserveAspectRatio="none" aria-hidden="true">
      {[0, 0.5, 1].map(fraction => <line key={fraction} className="completion-grid" x1={0} x2={plotWidth} y1={plotHeight * fraction} y2={plotHeight * fraction} />)}
      {buckets.map((bucket, index) => {
        if (!bucket.sufficient || bucket.p25Ms === null || bucket.p50Ms === null || bucket.p75Ms === null || bucket.p90Ms === null) return null;
        const x = column * index + column / 2;
        const y25 = yOf(bucket.p25Ms), y75 = yOf(bucket.p75Ms), y50 = yOf(bucket.p50Ms), y90 = yOf(bucket.p90Ms);
        return <g key={bucket.id}><line className="completion-extent" x1={x} x2={x} y1={y75} y2={y90} /><rect className="completion-interval" x={x - 9} y={Math.min(y25, y75)} width={18} height={Math.max(2, Math.abs(y25 - y75))} /><line className="completion-median" x1={x - 16} x2={x + 16} y1={y50} y2={y50} /></g>;
      })}
    </svg></div></div> : null}
    <div className="completion-chart-x" data-completion-aligned={plotted.length ? "plot" : "full"}>{buckets.map(bucket => <div key={bucket.id} data-completion-bucket={bucket.id} data-completion-sample={bucket.sufficient ? "ready" : "insufficient"} data-completion-count={bucket.count} data-p25={bucket.p25Ms ?? undefined} data-p50={bucket.p50Ms ?? undefined} data-p75={bucket.p75Ms ?? undefined} data-p90={bucket.p90Ms ?? undefined}><span>{bucket.label}</span><span>{bucket.count} 条{bucket.sufficient ? "" : "，样本不足"}</span>{bucket.sufficient && bucket.p25Ms !== null && bucket.p50Ms !== null && bucket.p75Ms !== null && bucket.p90Ms !== null ? <span className="sr-only">{`p25 ${seconds(bucket.p25Ms)} 秒，p50 ${seconds(bucket.p50Ms)} 秒，p75 ${seconds(bucket.p75Ms)} 秒，p90 ${seconds(bucket.p90Ms)} 秒`}</span> : <span className="sr-only">未绘制</span>}</div>)}</div>
    {plotted.length ? <ul className="completion-legend" aria-hidden="true"><li><span className="completion-interval-sample" />p25–p75</li><li><span className="completion-median-sample" />p50</li><li><span className="completion-extent-sample" />至 p90</li></ul> : null}
  </>;
}
export function RequestHistory({ model, completion }: { readonly model: RequestHistoryModel; readonly completion: CompletionTimeModel }) {
  const q = model.query;
  return <>
    <RequestFiltersIsland control={{action:new URL(model.listUrl, "https://console.invalid").pathname,query:{from:q.from,to:q.to,plan:q.plan,user:q.user,result:q.result,request:q.request},services:model.services,retentionDays:model.retentionDays}} />
    <CompletionChart model={completion} retryHref={`${model.listUrl}#request-history`} />
    <ObjectWorkspace className="request-object-workspace" task={q.record ? <div id="request-detail" tabIndex={-1}>{model.detail ? <RequestDetail row={model.detail} model={model} /> : <section role="status" className="unavailable-view" data-request-missing=""><div className="task-card-head"><h2>未找到保留记录</h2><TaskClose href={`${model.listUrl}#request-history`} label="收起请求详情"/></div><p>这条内部记录可能未采集、已清理或不可用。查不到记录不代表没有发生请求。</p><HistoryScope model={model} id="request-missing-scope"/></section>}</div> : null} collection={<div className="request-collection"><Table className="request-table" scrollLabel="保留的请求记录" role="table" aria-label="保留的请求记录"><colgroup><col className="request-time-column"/><col className="request-person-column"/><col className="request-service-column"/><col className="request-path-column"/><col className="request-result-column"/><col className="request-status-column"/><col className="request-latency-column"/><col className="request-inspect-column"/></colgroup><TableHeader role="rowgroup"><TableRow role="row"><TableHead scope="col">时间（UTC）</TableHead><TableHead scope="col">成员（当前）</TableHead><TableHead scope="col">服务</TableHead><TableHead scope="col">请求路径</TableHead><TableHead scope="col">结果</TableHead><TableHead scope="col" className="number">上游状态</TableHead><TableHead scope="col" className="number">耗时</TableHead><TableHead scope="col">操作</TableHead></TableRow></TableHeader><TableBody role="rowgroup">
      {model.rows.map(row=><TableRow role="row" key={row.id} data-request-record={row.id} data-state={row.id===q.record?"selected":undefined}>
        <TableCell role="cell"><time dateTime={row.at} title={row.at}><span>{formatOperatorInstant(row.at).split(" ")[0]}</span>{" "}<span>{formatOperatorInstant(row.at).split(" ").slice(1).join(" ")}</span></time></TableCell>
        <TableCell role="cell">{row.currentEmail ?? row.userId ?? "未记录"}</TableCell>
        <TableCell role="cell">{row.service}</TableCell>
        <TableCell role="cell"><code>{row.path ?? "路径未记录"}</code></TableCell>
        <TableCell role="cell"><Result value={row.status}/></TableCell>
        <TableCell role="cell" className="number">{row.upstreamStatus ?? "未记录"}</TableCell>
        <TableCell role="cell" className="number"><span className="sr-only">耗时 </span>{row.latencyMs===null?"未记录":`${formatNumber(row.latencyMs)} ms`}</TableCell>
        <TableCell role="cell"><a className="action-link request-record-link" data-dashboard-link="" data-task-link="" href={row.href} aria-label={`查看请求 ${row.id}`}><span>查看</span><ChevronRight className="ui-icon" aria-hidden="true" /></a></TableCell>
      </TableRow>)}
    </TableBody></Table>
    {!model.rows.length ? <p role="status" data-request-empty="">{q.from || q.to || q.plan || q.user || q.result || q.request ? "没有符合筛选的保留记录。不代表没有发生请求；也可清除筛选查看。" : "没有保留的请求记录。不代表没有发生请求。"}</p> : null}
    {model.previousUrl || model.nextUrl || q.cursor ? <nav aria-label="请求记录分页" className="request-pagination">
      {model.previousUrl ? <a className="action-link" data-dashboard-link="" href={`${model.previousUrl}#request-history`}>较新记录</a> : null}
      {model.nextUrl ? <a className="action-link" data-dashboard-link="" href={`${model.nextUrl}#request-history`}>较旧记录</a> : null}
      {q.cursor ? <a className="action-link" data-dashboard-link="" href={`${inventoryUrl(model.listUrl, { audit_cursor: null, audit_direction: null })}#request-history`}>最新一页</a> : null}
    </nav> : null}</div>}/>
  </>;
}
