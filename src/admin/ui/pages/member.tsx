import { Fragment } from "react";
import { generateId } from "../../../crypto";
import type { ServiceContext } from "../../../auth/service-delegation";
import { memberHref } from "../../member-href";
import type { SurfaceCreditState } from "../../../auth/credits";
import type { ClientSetupFile } from "../../client-setup";
import { type MemberAccessModel, type MemberKeyFact, type MemberSurfaceFact, type ReadFact, verificationSurface } from "../../member-access";
import { useMemberScope } from "../../member-scope";
import { Button } from "../components/button";
import { ConfirmationFallback } from "../fields";
import { CopySecretIsland, MemberKeyFormIsland, TaskEditorIsland } from "../islands";
import { type CheckControl, type SelectControl } from "../models";
import { UsagePage, type UsagePageModel } from "./usage";
import { SyncTask } from "./setup";
import { Badge } from "../components/badge";
import { InfoPopover } from "../components/info-popover";
import { Progress } from "../components/progress";
import { Card, CardContent, CardHeader, CardTitle } from "../components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/table";
import { Icon } from "../icon";

export type MemberView = "home" | "keys" | "usage" | "quota" | "setup";
export const MEMBER_VIEWS: readonly MemberView[] = ["home", "keys", "usage", "quota", "setup"];
export function isMemberView(value: string): value is MemberView { return MEMBER_VIEWS.includes(value as MemberView); }
const label = (surface: string) => ({codex:"Codex",grok:"Grok",xai:"xAI API"}[surface] ?? surface);
const scopeNames = (scopes: readonly string[]) => scopes.map(scope => scope.split(":")[1] ?? scope);
const scopeSummary = (scopes: readonly string[]) => scopeNames(scopes).map(label).join("、") || "没有服务";
function instant(value: string | null): string {
  if (!value) return "未记录";
  const time = Date.parse(value);
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0,16).replace("T"," ")} UTC` : value;
}
const serviceStatus: Record<MemberSurfaceFact["reason"],string> = {unknown:"状态未读到",unconfigured:"待配置",disabled:"已停用",zero:"无新建额度",exhausted:"付费额度已用完","no-key":"待创建密钥","default-unavailable":"新建连接需管理员处理","default-unknown":"新建连接状态未知",expired:"密钥已失效","binding-unavailable":"连接需处理","binding-unknown":"连接状态未知","metadata-ready":"待任务验证"};
function shortDate(value:string|null):string { return value ? instant(value).slice(0,10) : "无到期时间"; }
function CreditUsage({state,service}: {state:SurfaceCreditState;service:string}) {
  const cap = state.mode === "unlimited" ? "不限" : state.mode === "disabled" ? "已停用" : state.monthly_allowance;
  const progress = state.mode === "limited" && state.monthly_allowance !== null && state.monthly_allowance > 0
    ? Math.min(100,Math.max(0,state.consumed_credits / state.monthly_allowance * 100)) : null;
  return <div className="member-credit-usage"><span className="member-credit-value"><span className="sr-only">已用 / 上限：</span>{state.consumed_credits} / {cap}</span>{progress !== null ? <Progress value={progress} aria-label={`${service} 本月已用额度占比`}/> : null}</div>;
}
export function MemberHomePage({model}: {model:MemberAccessModel}) {
  const scope = useMemberScope(); const memberHref = scope.href;
  const explanations = model.surfaces.filter(fact=>fact.reason!=="metadata-ready");
  return <><h1 className="sr-only">{scope.service ? scope.label("工作台") : "我的工作台"}</h1>
    <section className="member-workbench" aria-label="服务工作台">
      <Table className="member-workbench-table" data-member-home="true" aria-label="服务、密钥与最近任务请求"><TableHeader><TableRow><TableHead className="member-service-head">服务{explanations.length > 0 ? <InfoPopover id="member-service-rules" label="服务说明" iconOnly><ul>{explanations.map(fact=><li key={fact.id}>{label(fact.id)}：{serviceStatus[fact.reason]}</li>)}</ul></InfoPopover> : null}</TableHead><TableHead>本月额度（credits）</TableHead><TableHead>关联密钥</TableHead><TableHead>最近任务请求结果</TableHead></TableRow></TableHeader><TableBody>{model.surfaces.map(fact=>{
        const keys = model.keys.known ? model.keys.value.filter(item=>item.key.scopes.includes(`surface:${fact.id}:production`) && item.key.lifecycle.state === "active") : [];
        const observations = model.keys.known ? model.keys.value.flatMap(item => item.tasks.known ? item.tasks.value.filter(task=>verificationSurface(task.route_profile_id)===fact.id).flatMap(task=>[
          ...(task.last_success_at ? [{key:item.key,at:task.last_success_at,ok:true}] : []), ...(task.last_failure_at ? [{key:item.key,at:task.last_failure_at,ok:false}] : [])
        ]) : []).sort((a,b)=>b.at.localeCompare(a.at)) : [];
        const latest = observations[0]; const unknownTasks = model.keys.known && model.keys.value.some(item=>item.key.scopes.includes(`surface:${fact.id}:production`) && !item.tasks.known);
        return <TableRow key={fact.id} data-surface={fact.id} data-service-reason={fact.reason}>
          <TableCell><strong>{label(fact.id)}</strong>{fact.reason === "default-unavailable" || fact.reason === "binding-unavailable" ? <span className="record-subline">{fact.reason === "default-unavailable" ? "新建连接不可用" : "密钥绑定不可用"}，请联系管理员处理。</span> : fact.reason === "default-unknown" || fact.reason === "binding-unknown" ? <span className="record-subline" role="alert">连接状态未读到。<a href={memberHref("home")}>重新读取</a></span> : null}</TableCell>
          <TableCell>{!fact.quota.known ? <span role="alert">未读到</span> : <CreditUsage state={fact.quota.value} service={label(fact.id)}/>}</TableCell>
          <TableCell>{!model.keys.known ? <span role="alert">密钥未读到</span> : keys.length ? <ul className="workbench-key-links">{keys.map(item=><li key={item.key.id}><a href={memberHref("keys",item.key.id)}>{item.key.name ?? item.key.key_prefix}</a><Button asChild variant="ghost" size="icon"><a href={memberHref("setup")} aria-label={`配置客户端：${item.key.name ?? item.key.key_prefix}`} title="配置客户端"><Icon name="configure"/></a></Button></li>)}</ul> : <><span className="caption">无有效密钥</span>{fact.existing.known && fact.existing.value.total > 0 ? <a className="record-subline" href={memberHref("keys")}>查看历史密钥</a> : null}{fact.entitlement === "eligible" && fact.default === "configured" ? <a className="record-subline" href={`${memberHref("keys")}#member-key-form`}>创建密钥</a> : null}</>}</TableCell>
          <TableCell>{unknownTasks || !model.keys.known ? <span role="alert">结果未读到</span> : latest ? <a className="member-task-result" href={memberHref("keys",latest.key.id)}><time dateTime={latest.at} data-tone={latest.ok ? "ok" : "bad"}><span className="sr-only">{latest.ok ? "最近任务成功：" : "最近任务失败："}</span>{instant(latest.at)}</time><span className="record-subline">{latest.key.name ?? latest.key.key_prefix}</span></a> : null}</TableCell>
        </TableRow>;
      })}</TableBody></Table>
    </section>
  </>;
}
export function MemberDelegatedServices({services}: {readonly services:readonly ServiceContext[] | null}) {
  const scope = useMemberScope();
  if (services?.length === 0) return null;
  return <Card className="member-delegated-services" aria-label="我管理的服务账号"><CardHeader><CardTitle><h2>我管理的服务账号</h2></CardTitle></CardHeader><CardContent>{services === null ? <p role="alert" data-delegated-read-state="unknown">我管理的服务账号暂时未读到。<a href={scope.href("home")}>重新读取</a></p> : <ul>{services.map(service=><li key={service.id}><a href={memberHref("home",undefined,service.id)} aria-label={`${service.display_name}（${service.id}）`}><span className="member-delegated-identity"><strong>{service.display_name}</strong><code>{service.id}</code></span><Badge data-tone={service.status==="active"?"ok":undefined}>{service.status==="active"?"已启用":"已停用"}</Badge><Icon name="arrow"/></a></li>)}</ul>}</CardContent></Card>;
}
export function MemberQuotaPage({states}: {states:ReadFact<SurfaceCreditState[]>}) {
  const scope = useMemberScope(); const memberHref = scope.href;
  const resets = states.known ? [...new Set(states.value.map(state=>state.reset_at))] : [];
  return <><h1 className="sr-only">{scope.label("额度")}</h1>
    {!states.known ? <p role="alert" data-read-state="unknown">额度暂时未读到。<a href={memberHref("keys")}>管理已有密钥</a></p> : <section className="member-quota-board" aria-label="额度"><Table className="member-quota-table" data-member-quota="true" aria-label="各服务的额度政策"><TableHeader><TableRow><TableHead>服务</TableHead><TableHead className="number">每月上限（credits）</TableHead><TableHead>已用 / 上限</TableHead><TableHead className="number"><span>剩余</span><InfoPopover id="member-quota-rules" label="额度规则" iconOnly><p>此账号的密钥共用服务额度。0 额度只允许已授权的零消耗操作；停用拒绝新请求。xAI API 使用上游团队共享资源。</p><ul>{states.value.map(state=><li key={state.surface_grant}>{label(state.surface_grant.split(":")[1]!)}：{state.source === "personal" ? "自定义额度" : state.source === "organization" ? "组织默认" : "未配置"}{resets.length > 1 ? <>；<time dateTime={state.reset_at}>{state.reset_at.slice(0,10)} UTC 重置</time></> : null}</li>)}</ul>{resets.length === 1 ? <p><time dateTime={resets[0]}>{resets[0]!.slice(0,10)} UTC 重置</time></p> : null}</InfoPopover></TableHead></TableRow></TableHeader><TableBody>{states.value.map(state=><TableRow key={state.surface_grant} data-surface={state.surface_grant.split(":")[1]} data-credit-mode={state.mode}>
      <TableCell><strong>{label(state.surface_grant.split(":")[1]!)}</strong></TableCell>
      <TableCell className="number">{state.mode === "unlimited" ? "不限" : state.mode === "disabled" ? "已停用" : state.monthly_allowance}</TableCell>
      <TableCell className="credit-used"><CreditUsage state={state} service={label(state.surface_grant.split(":")[1]!)}/></TableCell>
      <TableCell className="number"><strong>{state.mode === "unlimited" ? "不限" : state.mode === "disabled" ? "已停用" : state.remaining_credits}</strong></TableCell>
    </TableRow>)}</TableBody></Table></section>}
  </>;
}
function expiryControl(now:Date,id:string):SelectControl {
  return {id,name:"expires_at",label:"有效期",required:false,value:"",options:[30,90,180,365].map(days=>({value:days===90?"":new Date(now.getTime()+days*86400000).toISOString(),label:`${days} 天`,disabled:false}))};
}
function ReturnField({keyId}: {keyId?:string}) {
  const scope = useMemberScope(); const memberHref = scope.href; return <input type="hidden" name="key_return" value={memberHref("keys",keyId)}/>; }
function ConfirmForm({action,message,submitLabel,keyId,children,quiet=false}: {action:string;message:string;submitLabel:string;keyId?:string;children?:React.ReactNode;quiet?:boolean}) {
  const scope = useMemberScope(); if (scope.service) message = `服务账号 ${scope.service.display_name}（${scope.service.id}）：${message}`;
  return <form method="post" action={action} data-confirmation={message}><ReturnField keyId={keyId}/>{action.endsWith("replace")?<input type="hidden" name="submission_id" value={generateId("submit")}/>:null}<ConfirmationFallback message={message}/>{children}<Button type="submit" variant={quiet || action.endsWith("replace")?"outline":"destructive"} className={quiet?"quiet-destructive":undefined}>{submitLabel}</Button></form>;
}
const lifecycleLabels: Record<MemberKeyFact["key"]["lifecycle"]["state"],string> = {active:"有效",expired:"已过期",revoked:"已撤销",paused:"账号已暂停",inactive:"已停用",unknown:"状态未知"};
function TaskEvidence({item}: {item:MemberKeyFact}) {
  return <section className="key-task-evidence" aria-label="这个密钥的任务记录"><header className="task-card-head"><h3>最近任务请求结果</h3><Badge>当前密钥</Badge></header>
    {!item.tasks.known?<p>任务记录暂时未读到。</p>:scopeNames(item.key.scopes).map(surface=>{
      const rows=item.tasks.known?item.tasks.value.filter(row=>verificationSurface(row.route_profile_id)===surface):[];
      const success=rows.map(row=>row.last_success_at).filter((value):value is string=>value!==null).sort().at(-1);
      const failure=rows.map(row=>row.last_failure_at).filter((value):value is string=>value!==null).sort().at(-1);
      const latest = failure&&(!success||failure>success)?failure:success;
      return <div className="key-task-row" key={surface} data-key-task={surface}><strong>{label(surface)}</strong><span data-tone={latest===failure&&failure?"bad":success?"ok":undefined}>{success?`最近成功 ${instant(success)}`:"未记录成功任务"}{failure?`；最近失败 ${instant(failure)}`:""}</span></div>;
    })}
  </section>;
}
function KeyDetail({item,now}: {item:MemberKeyFact;now:Date}) {
  const scope = useMemberScope(); const memberHref = scope.href; const key = item.key;
  const hidden = {key_return: memberHref("keys",key.id)};
  const replaceMessage = key.lifecycle.state === "active" ? `更换 ${key.key_prefix}？将创建同家族的新密钥；旧密钥在到期或另行撤销之前仍可认证。请验证新密钥后再撤销旧密钥。` : `续发 ${key.key_prefix}？将创建同家族的新密钥，旧密钥不会恢复有效。`;
  return <section className="member-key-detail" data-key-detail={key.id} aria-label={`管理密钥 ${key.name ?? key.key_prefix}`}>
    <header className="person-access-head"><h2>{key.name ?? "未命名密钥"}</h2><Button asChild variant="ghost"><a href={memberHref("keys")} data-member-key-close={key.id}><Icon name="close"/>收起</a></Button></header>
    <dl className="key-facts"><div><dt>创建</dt><dd>{instant(key.created_at)}</dd></div><div><dt>到期</dt><dd>{instant(key.expires_at)}</dd></div><div><dt>最近使用</dt><dd>{instant(key.last_used_at)}</dd></div></dl>
    {item.family.relatives.length ? <p className="caption">同家族：{item.family.relatives.map((other,index)=><span key={other.id}>{index ? "、" : ""}<a href={memberHref("keys",other.id)} data-member-key-toggle={other.id}>{other.prefix}</a>（{lifecycleLabels[other.state as keyof typeof lifecycleLabels] ?? other.state}）</span>)}。新旧密钥的撤销分别操作。</p> : null}
    {item.bindings.filter(binding => binding.state !== "ready").map(binding => <p key={binding.surface} role={binding.state === "unknown" ? "alert" : undefined}>{label(binding.surface)}：{{missing:"未绑定连接",unavailable:"绑定连接需管理员处理",unknown:"绑定状态未读到",ready:""}[binding.state]}</p>)}
    <TaskEvidence item={item}/>
    <div className="key-edit-actions">
      <TaskEditorIsland control={{id:`rename-${key.id}`,label:"重命名",action:`${scope.prefix}/ui/keys/${encodeURIComponent(key.id)}/rename`,submitLabel:"保存名称",fields:[{label:"密钥名称",name:"name",value:key.name ?? "",required:true,maxLength:64}],hidden}}/>
      {item.replacement.allowed && scope.service?.status !== "disabled" ? <TaskEditorIsland control={{id:`replace-${key.id}`,label:"更换密钥",action:`${scope.prefix}/ui/keys/${encodeURIComponent(key.id)}/replace`,submitLabel:"更换",fields:[],select:expiryControl(now,`replace-expiry-${key.id}`),hidden:{...hidden,submission_id:generateId("submit")},confirmation:scope.service ? `服务账号 ${scope.service.display_name}（${scope.service.id}）：${replaceMessage}` : replaceMessage}}/> : key.status === "active" ? <p className="caption" data-replacement-state={item.replacement.reason ?? "unknown"}>{item.replacement.allowed === null ? "更换条件未读到" : item.replacement.reason === "family" ? "请先结束当前更换中的密钥重叠" : item.replacement.reason === "binding" ? "绑定连接需管理员处理" : "当前服务政策不允许更换"}</p> : null}
      {key.status !== "revoked" ? <ConfirmForm action={`${scope.prefix}/ui/keys/${encodeURIComponent(key.id)}/revoke`} keyId={key.id} message={`撤销 ${key.key_prefix}？后续认证将被拒绝，不能恢复；已开始的请求或外部任务不保证中止。`} submitLabel="撤销密钥" quiet/> : null}
    </div>
  </section>;
}
export function MemberKeysPage({model,now,selectedId}: {model:MemberAccessModel;now:Date;selectedId:string|null}) {
  const scope = useMemberScope(); const memberHref = scope.href;
  const surfaces:CheckControl[] = model.surfaces.map(fact=>({name:"surfaces",value:fact.id,label:label(fact.id),disabled:fact.entitlement!=="eligible"||fact.default!=="configured",checked:false}));
  const capacity = model.liveFamilies === null ? "密钥数量尚未读到。" : model.liveFamilies >= 5 ? "已达到 5 个有效密钥家族，请先撤销不再使用的密钥。" : "";
  const conditions = model.surfaces.filter(fact => fact.entitlement !== "eligible" || fact.default !== "configured").map(fact => `${label(fact.id)}：${fact.entitlement === "unknown" || fact.default === "unknown" ? "创建条件未读到" : fact.entitlement === "disabled" || fact.entitlement === "unconfigured" ? "服务未开放" : fact.entitlement === "zero" ? "无新建额度" : "默认连接需管理员处理"}`).join("；");
  return <><h1 className="sr-only">{scope.label("密钥")}</h1><div className="member-key-workspace" data-selected-key={String(Boolean(selectedId))}>
    <section className="member-key-inventory" id="member-key-inventory" tabIndex={-1} aria-label="密钥列表" data-member-key-collection={memberHref("keys")}>
      <Table className="member-keys-table" aria-label="密钥"><TableHeader><TableRow><TableHead>名称 / 前缀</TableHead><TableHead>服务</TableHead><TableHead>状态</TableHead><TableHead>到期</TableHead><TableHead>最近使用</TableHead><TableHead className="member-key-actions-head"><span className="sr-only">操作</span><div className="member-key-header-actions"><Button asChild variant="outline" size="icon"><a href="#member-key-form" data-member-create-toggle aria-controls="member-key-create-row" aria-expanded="true" aria-label="创建密钥" title="创建密钥"><Icon name="plus"/></a></Button>{model.keys.known && model.keys.value.length > 0 ? <div className="member-bulk-actions"><Button variant="ghost" aria-label={`撤销${scope.label("全部密钥")}`} title={`撤销${scope.label("全部密钥")}`} popoverTarget="key-bulk-actions"><Icon name="revoke"/>撤销全部</Button><div id="key-bulk-actions" popover="auto" className="key-action-popover"><ConfirmForm action={`${scope.prefix}/ui/keys/revoke-all`} message={`撤销${scope.label("全部密钥")}？后续认证将被拒绝，不能恢复。`} submitLabel={`撤销${scope.label("全部密钥")}`} quiet/></div></div> : null}</div></TableHead></TableRow></TableHeader><TableBody>
        <TableRow id="member-key-create-row" className="member-key-expanded-row" data-member-create-row><TableCell colSpan={6}><MemberKeyFormIsland model={{action:`${scope.prefix}/ui/keys`,returnHref:memberHref("keys"),submissionId:generateId("submit"),surfaces,expiry:expiryControl(now,"member-key-expiry"),canCreate:model.canCreate && scope.service?.status !== "disabled",lead:[scope.service?.status === "disabled" ? "服务账号已停用。" : "",capacity,conditions].filter(Boolean).join(" ") || null}}/></TableCell></TableRow>
        {!model.keys.known ? <TableRow><TableCell colSpan={6}><p role="alert" data-read-state="unknown">密钥列表暂时未读到。<a href={memberHref("keys",selectedId ?? undefined)}>重新读取</a></p></TableCell></TableRow> : model.keys.value.length === 0 ? <TableRow><TableCell colSpan={6}><p className="empty">{model.canCreate && scope.service?.status !== "disabled" ? "还没有密钥。请创建第一个密钥。" : "还没有密钥。当前不能新建，请展开创建区域查看条件。"}</p></TableCell></TableRow> : model.keys.value.map(item=><Fragment key={item.key.id}><TableRow data-key-id={item.key.id} data-state={selectedId === item.key.id ? "selected" : undefined}>
          <TableCell><a className="key-manage-link" href={memberHref("keys",item.key.id)} data-member-key-toggle={item.key.id} aria-controls={`member-key-detail-${item.key.id}`} aria-expanded={selectedId === item.key.id} aria-current={selectedId === item.key.id ? "true" : undefined}><strong>{item.key.name ?? "未命名密钥"}</strong><code className="record-subline">{item.key.key_prefix}</code></a></TableCell>
          <TableCell>{scopeSummary(item.key.scopes)}</TableCell><TableCell><Badge data-key-state={item.key.lifecycle.state}>{lifecycleLabels[item.key.lifecycle.state]}</Badge></TableCell>
          <TableCell>{shortDate(item.key.expires_at)}</TableCell><TableCell>{item.key.last_used_at ? shortDate(item.key.last_used_at) : "尚未使用"}</TableCell>
          <TableCell className="row-actions"><Button asChild variant="ghost" size="icon"><a href={memberHref("setup")} aria-label={`配置客户端：${item.key.name ?? item.key.key_prefix}`} title="配置客户端"><Icon name="configure"/></a></Button><Button asChild variant="ghost" size="icon"><a href={memberHref("keys",item.key.id)} data-member-key-toggle={item.key.id} aria-controls={`member-key-detail-${item.key.id}`} aria-expanded={selectedId === item.key.id} aria-label={`管理密钥：${item.key.name ?? item.key.key_prefix}`} title="管理密钥"><Icon name="expand"/></a></Button></TableCell>
        </TableRow><TableRow className="member-key-expanded-row" id={`member-key-detail-${item.key.id}`} data-member-key-row={item.key.id} data-member-key-open={selectedId === item.key.id ? "true" : undefined} hidden={selectedId !== item.key.id}><TableCell colSpan={6}><KeyDetail item={item} now={now}/></TableCell></TableRow></Fragment>)}
        {selectedId && model.keys.known && !model.keys.value.some(item=>item.key.id===selectedId) ? <TableRow data-member-key-missing><TableCell colSpan={6}><p data-key-state="missing">没有这个密钥。<a href={memberHref("keys")}>查看密钥列表</a></p></TableCell></TableRow> : null}
      </TableBody></Table>
    </section>
  </div></>;
}
export function MemberUsagePage({model}: {model:UsagePageModel}) {const scope = useMemberScope(); return <><h1 className="sr-only">{scope.label("用量")}</h1><UsagePage model={model}/></>;}
export function MemberSetupPage() {
  const scope = useMemberScope();
  return <><h1 className="sr-only">{scope.service ? scope.label("客户端配置") : "客户端配置"}</h1><section className="member-setup-config" aria-label="本机配置"><SyncTask recoveryHref={scope.href}/></section></>;
}
export function MemberSecretPage(props:{token:string;files:readonly ClientSetupFile[];previousPrefix:string|null;oldKeyRemainsActive?:boolean;keyId?:string;keyPrefix:string}) {
  const scope = useMemberScope(); const memberHref = scope.href;
  return <article className="panel one-time-result" data-one-time-key="true" data-member-return={memberHref("keys",props.keyId)}><h1>{scope.service ? `${scope.service.display_name} · 密钥已创建` : "密钥已创建"}</h1><p className="lede">请现在复制。离开这个页面后不会再显示。</p><CopySecretIsland control={{token:props.token}}/>
    <p className="note">新密钥前缀：<code>{props.keyPrefix}</code></p>
    {props.files.map(file=><section key={file.client} data-client-setup={file.client}><h2>{file.clientLabel}</h2><p>将 <code>{file.filename}</code> 中的选项合并到 <code>{file.installTarget}</code>。先备份原配置。</p><div className="credential-actions"><Button asChild variant="outline"><a href={`data:text/plain;charset=utf-8,${encodeURIComponent(file.content)}`} download={file.filename}>下载 {file.filename}</a></Button><InfoPopover id={`created-file-${file.client}`} label="查看配置内容"><pre>{file.content}</pre></InfoPopover></div></section>)}
    {props.previousPrefix?<p className="note">上一个密钥 {props.previousPrefix} {props.oldKeyRemainsActive?"仍可认证，直到到期或另行撤销。请验证新密钥后再单独撤销旧密钥。":"不会因为这次续发恢复有效。"}</p>:null}<p className="note">新密钥尚无任务验证记录。下载不能证明可用。</p><p><Button asChild variant="link"><a href={memberHref("keys",props.keyId)}>管理新密钥</a></Button></p>
  </article>;
}
export function MemberUnavailablePage({retryUrl}:{retryUrl:string}) {
  return <section className="gate" data-read-state="unavailable" role="alert"><h1>页面暂时打不开</h1><p>没有读到当前数据，请稍后重试。</p><Button asChild><a href={retryUrl}>再试一次</a></Button></section>;}
export function MemberMissingPage() {const scope = useMemberScope(); const memberHref = scope.href; return <section className="gate"><h1>没有这个页面</h1><p>请从导航中选择页面。</p><Button asChild><a href={memberHref("home")}>返回首页</a></Button></section>;}
