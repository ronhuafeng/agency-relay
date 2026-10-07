import type { ReactNode } from "react";
import { formatNumber, formatOperatorInstant } from "../../format";
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
        <Fact label="人员标识（记录）">{row.userId ?? "未记录"}</Fact>
        <Fact label="当前邮箱">{row.currentEmail ?? "对象已删除或标签不可用"}（非历史快照）</Fact>
        <Fact label="密钥标识（记录）">{row.keyId ?? "未记录"}</Fact>
        <Fact label="当前密钥名称">{row.currentKeyName ?? "对象已删除或标签不可用"}（非历史快照）</Fact>
        <Fact label="Mini 凭据归属标识">{row.credentialId ?? "未记录"}</Fact>
        <Fact label="安全错误码">{row.errorCode ?? (row.unrecognizedError ? "未识别，不展示原始值" : "未记录")}</Fact>
        <Fact label="总令牌">{row.tokens === null ? "未记录" : formatNumber(row.tokens)}</Fact>
        <Fact label="输入／缓存令牌">{row.inputTokens === null ? "未记录" : formatNumber(row.inputTokens)} / {row.cachedTokens === null ? "未记录" : formatNumber(row.cachedTokens)}</Fact>
        <Fact label="输出／推理令牌">{row.outputTokens === null ? "未记录" : formatNumber(row.outputTokens)} / {row.reasoningTokens === null ? "未记录" : formatNumber(row.reasoningTokens)}</Fact>
        <Fact label="提供商金额原始 ticks">{row.costTicks === null ? "未记录" : formatNumber(row.costTicks)}（Provisional；不是账单）</Fact>
      </dl>
    </InfoPopover><HistoryScope model={model} id="request-detail-scope"/></div>
  </Card>;
}

export function RequestHistory({ model }: { readonly model: RequestHistoryModel }) {
  const q = model.query;
  return <section id="request-history" aria-labelledby="request-history-title" className="panel usage-stack request-workspace" tabIndex={-1}>
    <h2 id="request-history-title" className="sr-only">请求记录</h2>
    <RequestFiltersIsland control={{action:new URL(model.listUrl, "https://console.invalid").pathname,query:{from:q.from,to:q.to,plan:q.plan,user:q.user,result:q.result,request:q.request},services:model.services,retentionDays:model.retentionDays}} />
    <ObjectWorkspace className="request-object-workspace" task={q.record ? <div id="request-detail" tabIndex={-1}>{model.detail ? <RequestDetail row={model.detail} model={model} /> : <section role="status" className="unavailable-view" data-request-missing=""><div className="task-card-head"><h2>未找到保留记录</h2><TaskClose href={`${model.listUrl}#request-history`} label="收起请求详情"/></div><p>这条内部记录可能未采集、已清理或不可用。查不到记录不代表没有发生请求。</p><HistoryScope model={model} id="request-missing-scope"/></section>}</div> : null} collection={<div className="request-collection"><div className="request-table"><Table scrollLabel="保留的请求记录" role="table" aria-label="保留的请求记录"><TableHeader role="rowgroup"><TableRow role="row"><TableHead scope="col">时间（UTC）</TableHead><TableHead scope="col">成员</TableHead><TableHead scope="col">服务</TableHead><TableHead scope="col">请求路径</TableHead><TableHead scope="col">结果</TableHead><TableHead scope="col" className="number">上游状态</TableHead><TableHead scope="col" className="number">耗时</TableHead><TableHead scope="col">操作</TableHead></TableRow></TableHeader><TableBody role="rowgroup">
      {model.rows.map(row=><TableRow role="row" key={row.id} data-request-record={row.id} data-state={row.id===q.record?"selected":undefined}>
        <TableCell role="cell"><time dateTime={row.at} title={row.at}>{formatOperatorInstant(row.at)}</time></TableCell>
        <TableCell role="cell">{row.currentEmail ?? row.userId ?? "未记录"}</TableCell>
        <TableCell role="cell">{row.service}</TableCell>
        <TableCell role="cell"><code>{row.path ?? "路径未记录"}</code></TableCell>
        <TableCell role="cell"><Result value={row.status}/></TableCell>
        <TableCell role="cell" className="number">{row.upstreamStatus ?? "未记录"}</TableCell>
        <TableCell role="cell" className="number"><span className="sr-only">耗时 </span>{row.latencyMs===null?"未记录":`${formatNumber(row.latencyMs)} ms`}</TableCell>
        <TableCell role="cell"><a className="action-link request-record-link" data-dashboard-link="" href={row.href} aria-label={`查看请求 ${row.id}`}><span>查看</span><ChevronRight className="ui-icon" aria-hidden="true" /></a></TableCell>
      </TableRow>)}
    </TableBody></Table></div>
    {!model.rows.length ? <p role="status" data-request-empty="">没有符合筛选的保留记录。不代表没有发生请求；也可清除筛选查看。</p> : null}
    <nav aria-label="请求记录分页" className="actions">
      {model.previousUrl ? <a className="action-link" data-dashboard-link="" href={`${model.previousUrl}#request-history`}>较新记录</a> : null}
      {model.nextUrl ? <a className="action-link" data-dashboard-link="" href={`${model.nextUrl}#request-history`}>较旧记录</a> : null}
      {q.cursor ? <a className="action-link" data-dashboard-link="" href={`${inventoryUrl(model.listUrl, { audit_cursor: null, audit_direction: null })}#request-history`}>最新一页</a> : null}
    </nav></div>}/>
  </section>;
}
