import { Fragment } from "react";
import { memberHref } from "../../member-href";
import type { AdminDashboardAccessModel } from "../../dashboard-data";
import { parseApiKeyScopes } from "../../../auth/authenticate";
import { productAccessLabels } from "../../client-setup";
import { keyIsExpired, keyStateLabel } from "../../key-label";
import { formatOperatorInstantOrDash, personLabel } from "../../format";
import { listExecutionPlans } from "../../../plans/execution-plans";
import { projectSurfaceCapabilityView } from "../../../plans/capabilities";
import { StatusSwitch } from "../components/status-switch";
import { Button } from "../components/button";
import { Badge } from "../components/badge";
import { NativeSelect } from "../components/native-select";
import { Card } from "../components/card";
import { InfoPopover } from "../components/info-popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/table";
import { Field, KeyExpiryField, ConfirmationFallback, InventorySearchView, confirmationAttributes, type Confirmation } from "../fields";
import { clientAccess } from "../person-access";
import { TaskEditorIsland, PeopleCreateIsland } from "../islands";
import { ClientAccessOption } from "../access-options";
import { CapabilityComparison } from "../capabilities";
import { PersonCredits } from "../person-credits";
import { KeyDetail } from "../key-detail";
import { ObjectWorkspace, TaskClose } from "../task-workspace";
import { DashLink, TaskLink } from "../chrome";
import { Icon } from "../icon";
import { inventoryUrl, DASHBOARD_PEOPLE_PAGE_SIZE } from "../href";
import { InventoryPages, inventorySearchControl } from "../inventory";
import { personInputMessage } from "../messages";
const capabilityView = projectSurfaceCapabilityView(listExecutionPlans());
const stateLabels = {granted: "密钥有效", paused: "账号已停用", expired: "密钥已过期", none: "无服务密钥"};
function ServiceIdentity({model, personUrl}: {readonly model: AdminDashboardAccessModel; readonly personUrl: string}) {
  const user = model.selectedUser!;
  const error = model.mutationFlash?.kind === "service_error" && model.mutationFlash.action === "rename" ? model.mutationFlash : null;
  const owner = model.serviceOwner;
  const assignableOwner = (model.serviceOwnerCandidates ?? []).some(candidate => candidate.id === owner?.owner_user_id);
  const warning: Confirmation = {
    primary: `更改「${user.display_name}」的管理人？原管理人立即失去控制台管理权。`,
    details: "新管理人只获得这个服务的密钥管理及额度、用量读取权。密钥不变：原管理人可能已复制的密钥在到期或撤销前仍可调用 API。不会自动停用服务或更换密钥。"
  };
  return <section className="workspace-section" id="identity" tabIndex={-1} aria-label="服务账号身份"><h2>服务账号</h2>
    <dl className="person-access-summary"><div><dt>账号 ID</dt><dd><code>{user.id}</code></dd></div></dl>
    <form className="board-form" method="post" action={`/admin/ui/services/${encodeURIComponent(user.id)}/name`} autoComplete="off" data-dashboard-draft="service-name" data-draft-scope={user.id}>
      <Field control={{label: "服务名称", name: "display_name", required: true, maxLength: 64, autoComplete: "off", value: error?.display_name ?? user.display_name ?? "", invalid: Boolean(error)}} />
      <input type="hidden" name="person_return" value={personUrl} /><Button type="submit" variant="outline">保存名称</Button>
    </form>
    <section aria-label="服务管理人"><h3>服务管理人</h3>
      {owner ? <dl className="person-access-summary"><div><dt>当前管理人</dt><dd>{owner.owner_user_id ? owner.owner_email ?? owner.owner_user_id : "未分配"}{owner.owner_user_id && owner.owner_status !== "active" ? <Badge>成员已停用</Badge> : null}</dd></div></dl> : null}
      {model.serviceOwnerKeys ? <InfoPopover id={`service-owner-keys-${user.id}`} label="交接时保留的密钥"><ul>{model.serviceOwnerKeys.map(key => <li key={key.id}><strong>{key.name ?? "未命名密钥"}</strong> · <code>{key.key_prefix}</code> · {key.status === "active" ? "未撤销" : key.status === "revoked" ? "已撤销" : "状态未识别"} · {key.expires_at ? `到期 ${formatOperatorInstantOrDash(key.expires_at)}` : "未设到期"}</li>)}</ul><p>更改管理人不会撤销这些密钥。<a href={memberHref("keys",undefined,user.id)}>管理服务密钥</a></p></InfoPopover> : null}
      {!owner || !model.serviceOwnerCandidates || !model.serviceOwnerKeys ? <p role="alert" data-service-owner-state="unknown">管理人或交接影响暂时无法读取，不代表未分配或没有密钥。<a href={model.canonicalUrl}>重新读取</a></p> :
      <form className="board-form" method="post" action={`/admin/ui/services/${encodeURIComponent(user.id)}/owner`} {...confirmationAttributes(warning)} data-confirm-service-owner="">
        <label htmlFor={`service-owner-${user.id}`}>新的管理人</label>
        <NativeSelect id={`service-owner-${user.id}`} name="owner_selection" required defaultValue={assignableOwner ? `user:${owner!.owner_user_id!}` : ""}>
          <option value="" disabled>请选择管理人或明确移除分配</option>
          <option value="remove">移除分配，保持管理员管理</option>
          {(model.serviceOwnerCandidates ?? []).map(candidate => <option key={candidate.id} value={`user:${candidate.id}`}>{candidate.canonical_email}</option>)}
        </NativeSelect>
        <input type="hidden" name="expected_revision" value={owner?.revision ?? 0}/><input type="hidden" name="person_return" value={personUrl}/><input type="hidden" name="confirm" value="1"/>
        <ConfirmationFallback message={warning.primary} details={warning.details}/><Button type="submit" variant="outline">更新管理人</Button>
      </form>}
      <p><a href={memberHref("keys",undefined,user.id)}>管理服务密钥</a> · <a href={memberHref("quota",undefined,user.id)}>查看服务额度</a> · <a href={memberHref("usage",undefined,user.id)}>查看服务用量</a></p>
    </section>
  </section>;
}
function ClassifyService({model, personUrl}: {readonly model: AdminDashboardAccessModel; readonly personUrl: string}) {
  const user = model.selectedUser!;
  if (user.account_kind !== "legacy_unresolved" || user.login_capable !== 0 || user.role !== "user" || user.email !== null || user.canonical_email !== null) return null;
  const error = model.mutationFlash?.kind === "service_error" ? model.mutationFlash : null;
  const warning: Confirmation = {
    primary: `把 ${user.id} 确认为服务账号？此操作不能撤回。`,
    details: "已有密钥、到期时间、绑定、额度、消耗和历史均保留，不会套用新账号的停用额度。服务账号不能转回成员。"
  };
  return <section className="workspace-section" aria-label="确认历史账号用途"><h2>确认历史账号用途</h2>
    <form className="board-form" method="post" action={`/admin/ui/services/${encodeURIComponent(user.id)}/classify`} {...confirmationAttributes(warning)} autoComplete="off" data-dashboard-draft="service-classify" data-draft-scope={user.id}>
      <Field control={{label: "服务名称", name: "display_name", required: true, maxLength: 64, autoComplete: "off", value: error?.display_name ?? "", invalid: Boolean(error)}} />
      <input type="hidden" name="expected_updated_at" value={user.updated_at} /><input type="hidden" name="person_return" value={personUrl} /><input type="hidden" name="confirm" value="1" />
      <ConfirmationFallback message={warning.primary} details={warning.details} /><Button type="submit" variant="outline">确认为服务账号</Button>
    </form>
  </section>;
}
function GiveAccess({model, personId, cancelHref}: {readonly model: AdminDashboardAccessModel; readonly personId: string; readonly cancelHref: string}) {
  return <><section className="workspace-section" id="give-access" tabIndex={-1} data-action="give-access" aria-label="创建密钥"><div className="task-card-head"><h3 className="task-title">创建密钥</h3><TaskClose href={cancelHref} label="收起创建密钥"/></div><form className="board-form" method="post" action="/admin/ui/keys" autoComplete="off" data-dashboard-draft="access" data-draft-scope={personId}>
    <input type="hidden" name="user_id" value={personId} /><Field control={{label: "密钥名称", name: "name", value: "客户端访问", required: true, maxLength: 64, autoComplete: "off"}} /><fieldset className="access-fieldset"><legend>新密钥包含的服务</legend><div className="access-choice-grid" data-access-choices="three" data-credential-selectors="three">{capabilityView.surfaces.map((access) => <ClientAccessOption key={access.id} access={access} model={model} />)}</div></fieldset>
    <KeyExpiryField /><div className="person-form-actions"><Button type="submit">创建密钥</Button><a className="action-link" data-dashboard-link="" data-discard-draft="" data-task-link="" href={cancelHref}>取消</a></div>
  </form></section><div id="capability-comparison"><CapabilityComparison model={{view: capabilityView, routesHref: "?view=surfaces"}} /></div></>;
}
function PersonKeys({model, personId, base}: {readonly model: AdminDashboardAccessModel; readonly personId: string; readonly base: string}) {
  if (!model.keyPage) return <section className="person-key-inventory" id="keys" tabIndex={-1} aria-label="密钥"><p role="alert">密钥列表暂时无法读取，不代表没有密钥。<a href={model.canonicalUrl}>重新读取</a></p>{model.selectedKeyId !== null ? <KeyDetail model={model}/> : null}</section>;
  const keys = model.keys.filter((key) => key.user_id === personId); const search = new URL(model.canonicalUrl, "https://console.invalid").searchParams;
  return <section className="person-key-inventory" id="keys" tabIndex={-1} data-advanced-keys="true" aria-label="密钥">
    {keys.length > 5 || model.keyPage.page > 1 || search.get("key_q") ? <InventorySearchView control={inventorySearchControl(model.canonicalUrl, "key_q", "key_page", "搜索密钥", "keys")} /> : null}
    <InventoryPages base={model.canonicalUrl} page={model.keyPage.page} hasNext={model.keyPage.hasNext} field="key_page" label="密钥" anchor="keys" />
    <Table className="member-keys-table person-keys-table" data-keys-table="true" aria-label="密钥"><TableHeader><TableRow><TableHead>名称 / 前缀</TableHead><TableHead>服务</TableHead><TableHead>状态</TableHead><TableHead>到期</TableHead><TableHead>最近使用</TableHead><TableHead><span className="sr-only">操作</span></TableHead></TableRow></TableHeader><TableBody>
      {keys.length === 0 ? <TableRow><TableCell colSpan={6}><p className="empty" data-empty={model.keyPage.page > 1 ? "page" : search.get("key_q") ? "filter" : "none"}>{model.keyPage.page > 1 ? "这一页没有密钥。" : search.get("key_q") ? "没有匹配的密钥。" : "还没有密钥。"}</p></TableCell></TableRow> : keys.map(key => <Fragment key={key.id}><TableRow data-key-id={key.id} data-state={key.id === model.selectedKeyId ? "selected" : undefined}>
        <TableCell><TaskLink className="key-link" ariaLabel={`管理密钥 ${key.key_prefix}`} href={inventoryUrl(base, {key: key.id}, "key-detail")}><strong>{key.name ?? "未命名密钥"}</strong><code className="record-subline">{key.key_prefix}</code></TaskLink></TableCell>
        <TableCell>{productAccessLabels(parseApiKeyScopes(key.scopes)).join("、") || "无服务权限"}</TableCell>
        <TableCell><Badge className="key-state" data-key-state={key.status !== "active" ? "revoked" : keyIsExpired(key, model.nowMs) ? "expired" : model.selectedUser?.status !== "active" ? "paused" : "active"}>{keyStateLabel(key, model.selectedUser ?? undefined, model.nowMs)}</Badge></TableCell>
        <TableCell>{key.expires_at ? <time dateTime={key.expires_at} title={key.expires_at}>{key.expires_at.slice(0,10)}</time> : "无到期时间"}</TableCell>
        <TableCell>{key.last_used_at ? <time dateTime={key.last_used_at} title={key.last_used_at}>{key.last_used_at.slice(0,10)}</time> : "尚未使用"}</TableCell>
        <TableCell className="row-actions"><Button asChild variant="ghost" size="icon"><TaskLink ariaLabel="配置客户端" href={inventoryUrl(base, {view:"setup", person:personId, key:key.id, task:null, kind:null, page_size:null, q:null, page:null, key_q:null, key_page:null})}><Icon name="configure"/></TaskLink></Button><Button asChild variant="ghost" size="icon"><TaskLink ariaLabel="管理密钥" href={inventoryUrl(base, {key:key.id}, "key-detail")}><Icon name="more"/></TaskLink></Button></TableCell>
      </TableRow>{key.id === model.selectedKeyId ? <TableRow className="member-key-expanded-row"><TableCell colSpan={6}><KeyDetail model={model}/></TableCell></TableRow> : null}</Fragment>)}
    </TableBody></Table>
    {model.selectedKeyId !== null && !keys.some(key => key.id === model.selectedKeyId) ? <KeyDetail model={model}/> : null}
  </section>;
}
function PersonIdentity({model, personUrl}: {readonly model: AdminDashboardAccessModel; readonly personUrl: string}) {
  const user = model.selectedUser; if (!user) return null;
  if (user.account_kind === "service") return <ServiceIdentity model={model} personUrl={personUrl} />;
  const role = user.role === "admin" ? "user" : "admin";
  const roleLabel = role === "admin" ? "设为管理员" : "设为普通成员";
  const roleWarning: Confirmation = {primary: `${roleLabel}：${personLabel(user)}？${role === "admin" ? "管理员可以管理组织成员、额度和上游连接。" : "此人立即失去组织管理权。"}`, details: "个人密钥与额度不会随角色改变。"};
  const emailWarning: Confirmation = {primary: `迁移 ${personLabel(user)} 的登录邮箱？旧会话立即失效。`, details: "需用新邮箱重新登录。账号 ID、密钥、额度和历史保留；此前复制的密钥不会自动撤销。"};
  const error = model.mutationFlash?.kind === "user_lifecycle_error" && model.mutationFlash.action === "email" ? model.mutationFlash : null;
  return <section className="workspace-section person-identity-actions" id="identity" tabIndex={-1} aria-label="身份设置">
    {user.login_capable !== 1 ? <Badge>尚不能登录</Badge> : <TaskEditorIsland control={{id:`role-${user.id}`,label:"更改角色",action:`/admin/ui/users/${encodeURIComponent(user.id)}/role`,submitLabel:roleLabel,fields:[],hidden:{role,confirm:"1",person_return:personUrl},confirmation:roleWarning.primary,confirmationDetails:roleWarning.details}}/>}
    <TaskEditorIsland control={{id:`email-${user.id}`,label:"更改登录邮箱",action:`/admin/ui/users/${encodeURIComponent(user.id)}/email`,submitLabel:"迁移邮箱",fields:[{label:"新的组织邮箱",name:"email",type:"email",required:true,maxLength:254,autoComplete:"off",value:error?.email ?? "",invalid:Boolean(error)}],hidden:{confirm:"1",person_return:personUrl},confirmation:emailWarning.primary,confirmationDetails:emailWarning.details,confirmEmail:true,draftKind:"person",draftScope:user.id}}/>
    <ClassifyService model={model} personUrl={personUrl}/>
  </section>;
}

function AssignedServices({model, personUrl}: {readonly model: AdminDashboardAccessModel; readonly personUrl: string}) {
  const impact = model.assignedServiceImpact;
  if (!impact || impact.known && impact.services.length === 0 && !impact.moreServices) return null;
  return <section className="workspace-section" id="assigned-services" tabIndex={-1} aria-label="服务账号与离职影响" data-assigned-service-impact="">
    <h3>管理的服务账号</h3>

    {!impact.known ? <p role="alert" data-service-impact-state="unknown">服务分配暂时无法读取，不代表没有服务账号。<a href={personUrl}>重新读取账号详情</a></p> : <>
      {impact.services.length === 0 ? <p>当前没有分配的服务账号。</p> : <ul>{impact.services.map(service => <li key={service.id}>
        <h4>{service.display_name} · <code>{service.id}</code></h4><p>服务状态：{service.status === "active" ? "启用" : "停用"}；停用管理人不会改变此状态。</p>
        <p><a href={memberHref("keys",undefined,service.id)}>单独管理服务密钥：{service.display_name}</a> · <a href={inventoryUrl(personUrl,{person:service.id,key:null})}>查看服务与管理人分配</a></p>
        {service.keys === null ? <p role="alert" data-service-impact-state="unknown">这个服务的密钥元数据暂时无法读取，不代表没有密钥。请打开服务密钥页面核对。</p> : service.keys.length === 0 ? <p>当前没有密钥。</p> : <ul>{service.keys.map(key => <li key={key.id}><code>{key.key_prefix}</code> · {key.name ?? "未命名"} · 存储状态 {key.status} · 到期 {key.expires_at ?? "无到期时间"} · <a href={memberHref("keys",key.id,service.id)}>单独撤销或更换</a></li>)}</ul>}
        {service.moreKeys ? <p>仅显示前 10 个密钥；请打开该服务的密钥页面检查其余密钥。</p> : null}
      </li>)}</ul>}
      {impact.moreServices ? <p>仅显示前 20 个当前分配的服务账号，还有更多服务未显示；请继续在账号列表核对服务分配。</p> : null}
    </>}
  </section>;
}
function PersonDetail({model, giving, personUrl}: {readonly model: AdminDashboardAccessModel; readonly giving: boolean; readonly personUrl: string}) {
  const user = model.selectedUser; if (!user) return null;
  const next = user.status === "active" ? "disabled" : "active"; const name = personLabel(user); const warning: Confirmation = user.account_kind === "service"
    ? next === "disabled" ? {primary: `停用服务账号 ${name}（${user.id}）？后续 API 鉴权立即被拒绝。`, details: "不保证中止已经开始的请求或外部任务。"}
      : {primary: `启用服务账号 ${name}（${user.id}）？有效密钥恢复原有访问。`, details: "额度限制仍然有效。已撤销的密钥不会恢复。"}
    : next === "disabled" ? {primary: `停用 ${name}？此人立即无法登录，个人密钥停止工作。`, details: "服务账号及其密钥不受影响，已复制的服务密钥仍可能被使用，请另行核对并撤销或更换；不会移出飞书；已开始的请求或外部任务不保证中止。"}
      : {primary: `启用 ${name}？有效密钥恢复原有访问。`, details: "额度限制仍然有效。旧控制台会话不会恢复，需要重新登录。"};
  return <><header className="person-detail-head"><div className="person-detail-identity"><div className="person-title"><h2>{user.account_kind === "legacy_unresolved" ? "待确认账号" : name}</h2><Badge>{user.account_kind === "service" ? "服务账号" : user.account_kind === "legacy_unresolved" ? "待确认" : user.role === "admin" ? "管理员" : "成员"}</Badge></div></div>
    <div className="task-head-actions"><form className="inline-form person-status-form" id="person-status" aria-label="账号访问状态" method="post" action={`/admin/ui/users/${encodeURIComponent(user.id)}/status`} data-action="user-status" {...confirmationAttributes(warning)}><ConfirmationFallback message={warning.primary} details={warning.details} /><input type="hidden" name="person_return" value={personUrl} /><input type="hidden" name="status" value={next} /><input type="hidden" name="confirm" value="1" /><StatusSwitch enabled={user.status === "active"} label={name} /></form><TaskClose href={inventoryUrl(personUrl, {person:null,key_q:null,key_page:null}, "people-list")} label="收起账号详情"/></div>
    </header>
    <nav className="section-links" aria-label="账号内容"><a href="#keys">密钥</a><a href="#credits">额度</a><a href="#identity">{user.account_kind === "service" ? "身份与管理人" : "身份与权限"}</a>{model.assignedServiceImpact && (!model.assignedServiceImpact.known || model.assignedServiceImpact.services.length > 0) ? <a href="#assigned-services">管理的服务</a> : null}</nav>
    <section className="workspace-section"><div className="person-access-head"><h2>密钥</h2>{giving ? null : <Button asChild><TaskLink href={inventoryUrl(personUrl,{task:"give-access"},"give-access")}><Icon name="plus"/>创建密钥</TaskLink></Button>}</div>
      {giving ? <GiveAccess model={model} personId={user.id} cancelHref={`${personUrl}#keys`} /> : null}<PersonKeys model={model} personId={user.id} base={personUrl}/></section>
    <section className="workspace-section" id="credits" tabIndex={-1} data-credit-allowances="true"><PersonCredits model={model} personId={user.id} /></section><PersonIdentity model={model} personUrl={personUrl} /><AssignedServices model={model} personUrl={personUrl} />
  </>;
}
function PeopleRow({model, user, selected, href}: {
  readonly model: AdminDashboardAccessModel;
  readonly user: AdminDashboardAccessModel["users"][number];
  readonly selected: boolean;
  readonly href: string;
}) {
  const marks = clientAccess(model, user).filter(item => item.state !== "none");
  const unresolved = user.account_kind === "legacy_unresolved";
  const name = unresolved && /^usr_[0-9a-f-]{36}$/i.test(user.id) ? "待确认账号" : personLabel(user);
  return <TableRow data-user-id={user.id} data-state={selected ? "selected" : undefined}>
    <TableCell className="people-identity-cell"><TaskLink className="person-link" href={href} current={selected}>
      <span className="person-identity"><strong>{name}</strong>{unresolved || user.account_kind === "service" ? <small title={user.id}>{user.id}</small> : null}</span>
    </TaskLink></TableCell>
    <TableCell data-label="密钥授权"><span className="person-access-list">{marks.length === 0 ? <span className="meta">无服务密钥</span> : marks.map(({client, label, state}) => <Badge key={client} className="person-access" data-access-state={state}>{label}<span className="sr-only">：{stateLabels[state]}</span>{state === "expired" || state === "paused" ? <span aria-hidden="true">{state === "expired" ? " · 已过期" : " · 已暂停"}</span> : null}</Badge>)}</span></TableCell>
    <TableCell data-label="状态"><span className="person-state" data-enabled={user.status === "active"}>{user.status === "active" ? "已启用" : "已停用"}</span></TableCell>
    <TableCell className="people-row-arrow"><Button asChild variant="ghost" size="icon"><TaskLink href={href} ariaLabel={`查看 ${name} 的访问管理`}><Icon name="arrow" /></TaskLink></Button></TableCell>
  </TableRow>;
}

export function PeoplePage({model}: {readonly model: AdminDashboardAccessModel}) {
  const error = model.mutationFlash?.kind === "user_create_error" ? model.mutationFlash : null;
  const selectedId = model.mutationFlash?.kind === "user_created" ? model.mutationFlash.user_id : model.selectedPersonId ?? null;
  const serviceError = model.mutationFlash?.kind === "service_error" && model.mutationFlash.action === "create" ? model.mutationFlash : null;
  const adding = Boolean(model.addingPerson || error || model.addingService || serviceError);
  const peopleUrl = inventoryUrl(model.canonicalUrl, {person: null, task: null, key: null, key_q: null, key_page: null});
  const personUrl = inventoryUrl(model.canonicalUrl, {task: null, key: null});
  const search = new URL(model.canonicalUrl, "https://console.invalid").searchParams;
  const detail = !adding && Boolean(model.selectedUser || selectedId !== null);
  return <section aria-label="成员与服务" className="people-workspace" data-view-role="people" data-keys-admin="true" data-show-detail={String(detail)}>
    <ObjectWorkspace task={detail ? <Card className="person-detail" id="person-detail" tabIndex={-1} data-person-detail={model.selectedUser?.id ?? ""}>{model.selectedUser ? <PersonDetail model={model} giving={Boolean(model.givingAccess)} personUrl={personUrl} /> : <section className="workspace-section"><div className="task-card-head"><h2>未显示账号</h2><TaskClose href={`${peopleUrl}#people-list`} label="收起账号详情"/></div><p className="caption">请从列表中选择一个人。</p></section>}</Card> : null} collection={<aside className="people-index" id="people-list" tabIndex={-1} aria-label="账号列表">
      <div className="people-toolbar">
        <InventorySearchView control={inventorySearchControl(model.canonicalUrl, "q", "page", "搜索邮箱、名称或 ID", "people-list")} />
        <PeopleCreateIsland control={{returnHref:peopleUrl,initialKind:model.addingService ? "service" : model.addingPerson ? "human" : null,
          error:error ? {kind:"human",value:error.email,message:personInputMessage(error),code:error.error_code} : serviceError ? {kind:"service",value:serviceError.display_name,message:serviceError.message,code:serviceError.error_code} : null}}/>
      </div>
      <nav className="people-kinds" aria-label="账号类型">{([["human", "成员"], ["admin", "管理员"], ["service", "服务账号"], ["legacy_unresolved", "待确认"]] as const).map(([kind, label]) => <Button key={kind} asChild variant={(search.get("kind") ?? "human") === kind ? "secondary" : "ghost"}><DashLink href={inventoryUrl(model.canonicalUrl, {kind: kind === "human" ? null : kind, page: null}, "people-list")} aria-current={(search.get("kind") ?? "human") === kind ? "page" : undefined}>{label}</DashLink></Button>)}</nav>
      {search.get("kind") === "legacy_unresolved" ? <p className="inventory-scope">核实用途后，关联成员邮箱或确认为服务账号。</p> : null}
      <Table className="people-table" aria-label="账号和客户端访问"><TableHeader><TableRow><TableHead scope="col">账号</TableHead><TableHead scope="col">密钥授权</TableHead><TableHead scope="col">状态</TableHead><TableHead scope="col"><span className="sr-only">查看</span></TableHead></TableRow></TableHeader><TableBody>
        {model.users.length === 0 ? <TableRow><TableCell colSpan={4}><p className="empty" data-empty={model.peoplePage.page > 1 ? "page" : search.get("q") ? "filter" : "none"}>{model.peoplePage.page > 1 ? "这一页没有账号。" : search.get("q") ? "没有匹配的账号，试试其他邮箱或名称。" : "这个分类下还没有账号。"}</p></TableCell></TableRow> : model.users.map(user => <PeopleRow key={user.id} model={model} user={user} selected={user.id === selectedId && !adding} href={inventoryUrl(peopleUrl,{person:user.id},"person-detail")} />)}
      </TableBody></Table>
      <InventoryPages base={model.canonicalUrl} page={model.peoplePage.page} pageSize={Number(search.get("page_size") ?? DASHBOARD_PEOPLE_PAGE_SIZE)} hasNext={model.peoplePage.hasNext} field="page" label="账号" anchor="people-list" />
    </aside>}/>
  </section>;
}
