import { useState } from "react";
import type { CreditPolicyControl } from "./models";
import { readCreditPolicy } from "./models";
import { CreditPolicyForm, CreditPolicySwitch } from "./forms";
import { useEnhanced } from "./use-enhanced";
import { Button } from "./components/button";
import { Badge } from "./components/badge";
import { Progress } from "./components/progress";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/table";
import { Icon } from "./icon";
import { ConfirmationFallback } from "./fields";
import { formatNumber } from "../format";

interface CreditTableState {
  readonly mode: "limited" | "unlimited" | "disabled";
  readonly source: "personal" | "organization" | "unconfigured";
  readonly monthly_allowance: number | null;
  readonly consumed_credits: number;
  readonly remaining_credits: number | null;
  readonly reset_at: string;
}
export interface CreditTableRow { readonly control: CreditPolicyControl; readonly state: CreditTableState | null; readonly keyAccess: "granted" | "paused" | "expired" | "none" }
export function readCreditTable(value: unknown): readonly CreditTableRow[] | null {
  if (!Array.isArray(value) || !value.every(row=>row && readCreditPolicy(row.control) && ["granted","paused","expired","none"].includes(row.keyAccess) && (row.state === null || row.state && typeof row.state === "object" && ["limited","unlimited","disabled"].includes(row.state.mode) && ["personal","organization","unconfigured"].includes(row.state.source) && typeof row.state.reset_at === "string" && Number.isFinite(row.state.consumed_credits) && (row.state.monthly_allowance === null || Number.isFinite(row.state.monthly_allowance)) && (row.state.remaining_credits === null || Number.isFinite(row.state.remaining_credits))))) return null;
  return value;
}
function PolicyRow({row}: {readonly row: CreditTableRow}) {
  const enhanced = useEnhanced(); const [editing,setEditing] = useState(false); const {control,state} = row;
  const surface = control.id.split("-").at(-1);
  const cap = !state ? "未读到" : state.mode === "limited" ? formatNumber(state.monthly_allowance ?? 0) : state.mode === "unlimited" ? "不限" : "已停用";
  return <>
    <TableRow data-credit-user={control.personId} data-credit-surface={surface}>
      <TableCell><strong>{control.clientLabel} 额度</strong><span className="record-subline"><Badge>{state?.source === "personal" ? "账号额度" : state?.source === "organization" ? "组织默认" : state ? "未配置" : "未读到"}</Badge></span>{control.clientLabel === "xAI API" ? <span className="record-subline">团队共享资源</span> : null}</TableCell>
      <TableCell><span data-access-client={surface} data-access-state={row.keyAccess}>{{granted:"密钥有效",paused:"账号已停用",expired:"密钥已过期",none:"无服务密钥"}[row.keyAccess]}</span></TableCell>
      <TableCell className="number">{cap}</TableCell>
      <TableCell className="credit-used"><strong>{state ? formatNumber(state.consumed_credits) : "未读到"}</strong>{state?.mode === "limited" && (state.monthly_allowance ?? 0) > 0 ? <Progress aria-label={`${control.clientLabel} 本月已用额度占比`} value={Math.min(100,Math.max(0,state.consumed_credits / state.monthly_allowance! * 100))}/> : null}</TableCell>
      <TableCell className="number"><strong>{state?.mode === "limited" ? formatNumber(state.remaining_credits ?? 0) : cap}</strong>{state?.mode === "limited" && state.monthly_allowance === 0 ? <span className="record-subline">仅零消耗操作</span> : null}</TableCell>
      <TableCell><div className="credit-policy-controls">{state ? <><CreditPolicySwitch control={control} onEnable={() => setEditing(true)}/>{enhanced ? <Button type="button" variant="ghost" size="icon" title={`调整 ${control.clientLabel} 额度`} aria-label={`调整 ${control.clientLabel} 额度`} aria-expanded={editing} aria-controls={`${control.id}-editor`} onClick={()=>setEditing(!editing)}><Icon name="edit"/></Button> : null}</> : <span role="alert">读取失败</span>}</div></TableCell>
    </TableRow>
    {state ? <TableRow className="credit-editor-row" hidden={enhanced && !editing}><TableCell colSpan={6}><div id={`${control.id}-editor`} className="credit-editor" data-credit-editor-state={enhanced && !editing ? "closed" : "open"}>
      <CreditPolicyForm control={control} initialMode={control.mode === "disabled" ? "limited" : control.mode}/>
      <div className="credit-editor-secondary">{state.source === "personal" ? <form className="inline-form" method="post" action={control.action} data-action="credit-inherit" data-confirmation={`去掉 ${control.personLabel} 的个人 ${control.clientLabel} 额度，改用组织默认？已用量不会重置。`}><ConfirmationFallback message="确认改用组织默认额度"/><input type="hidden" name="action" value="inherit"/><input type="hidden" name="confirm" value="1"/><Button type="submit" variant="outline">使用组织默认</Button></form> : null}{enhanced ? <Button type="button" variant="ghost" onClick={()=>setEditing(false)}>取消</Button> : null}</div>
    </div></TableCell></TableRow> : null}
  </>;
}
export function CreditTableView({rows}: {readonly rows: readonly CreditTableRow[]}) {
  const resets = [...new Set(rows.flatMap(row=>row.state ? [row.state.reset_at] : []))];
  return <div className="credit-table-board" data-person-access-summary=""><Table scrollLabel="各服务的额度与请求准入比较" className="person-credit-table" aria-label="各服务的额度和请求准入"><TableHeader><TableRow><TableHead>服务 / 政策</TableHead><TableHead>密钥</TableHead><TableHead className="number">每月上限</TableHead><TableHead>已用</TableHead><TableHead className="number">剩余</TableHead><TableHead>请求准入</TableHead></TableRow></TableHeader><TableBody>{rows.map(row=><PolicyRow key={row.control.id} row={row}/>)}</TableBody></Table><div className="credit-table-footer"><span>credits / 月 · 此账号的密钥共用</span>{resets.length === 1 ? <time dateTime={resets[0]}>{resets[0]!.slice(0,10)} UTC 重置</time> : resets.length > 1 ? rows.map(row=>row.state ? <span key={row.control.id}>{row.control.clientLabel}：{row.state.reset_at.slice(0,10)} UTC 重置</span> : null) : null}</div></div>;
}
