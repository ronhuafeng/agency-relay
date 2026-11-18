import type {RuntimeMemberModel} from "../../../runtime/oauth";
import {memberHref} from "../../member-href";
import {Button} from "../components/button";
import {Badge} from "../components/badge";
import {Card} from "../components/card";
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from "../components/table";
import {ObjectWorkspace,TaskClose} from "../task-workspace";
import {TaskLink} from "../chrome";
import {ConfirmationFallback} from "../fields";
import {Field} from "../fields";
import type {RuntimeAdminModel} from "../../../runtime/console";

export const runtimeMemberHref=(id?:string)=>`${memberHref("integrations")}${id?`&installation=${encodeURIComponent(id)}`:""}`;
const installationState={enabled:"已启用",disabled:"已停用",retired:"已退役"};
const utc=(value:string)=>`${value.slice(0,19).replace("T"," ")} UTC`;

function ClientConsents({model,installation}:{readonly model:RuntimeMemberModel;readonly installation?:RuntimeMemberModel["installations"][number]}) {
  const clients=installation?model.consents.filter(client=>client.installation===installation.id):model.consents;
  return <section className="workspace-section" aria-label="客户端授权"><h3>客户端授权</h3>{!clients.length?<p>尚无客户端授权。完成终端登录并在授权页确认客户端、服务和权限。</p>:<Table aria-label="已记录的客户端授权"><TableHeader><TableRow><TableHead>客户端 / 服务</TableHead><TableHead>授权状态</TableHead><TableHead>到期（UTC）</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{clients.map(client=>{
    const currentInstallation=model.installations.find(row=>row.id===client.installation);
    const current=currentInstallation&&client.scope==="runtime.use"&&client.authority_revision===currentInstallation.authority_revision&&client.access_revision===currentInstallation.access_revision;
    const message=`撤销 ${client.client_name} 的客户端授权？后续请求将被拒绝。`;const details=`${client.resource}。不会退出浏览器、撤销其他客户端或撤回已执行的上游操作。`;
    return <TableRow key={client.id}><TableCell className="whitespace-normal">{client.client_name}<span className="record-subline">{currentInstallation?.label??"已无使用权限的服务"} · 名称由客户端自行提供</span></TableCell><TableCell className="whitespace-normal">{current?"已记录授权，未检查凭据":currentInstallation?"服务权限已变更，需要重新授权":"已无组织权限，后续调用被拒绝"}</TableCell><TableCell><time dateTime={client.expires_at}>{utc(client.expires_at)}</time></TableCell><TableCell>
      <form className="member-form" method="post" action={`/me/ui/runtime-clients/${client.id}/revoke`} data-confirmation={message} data-confirmation-details={details}><input type="hidden" name="installation" value={client.installation}/><input type="hidden" name="confirm" value="1"/><ConfirmationFallback message={message} details={details}/><Button type="submit" variant="outline">撤销授权</Button></form>
    </TableCell></TableRow>;
  })}</TableBody></Table>}
  <p className="caption">退出浏览器不撤销这些授权。管理员撤回组织权限或停用服务会拒绝后续调用；凭据退役由管理员处理。本地 token 过期、撤销或丢失时，在权限仍有效的前提下重新执行终端登录。</p></section>;
}

export function RuntimeMemberPage({model,selectedId}:{readonly model:RuntimeMemberModel;readonly selectedId:string|null}) {
  const selected=model.installations.find(row=>row.id===selectedId);
  const fact=selected?model.activity.find(row=>row.installation===selected.id):undefined;
  const collection=<section className="runtime-collection" aria-label="可用工具服务" id="runtime-installations"><h1 className="sr-only">我的工具服务</h1>
    {model.installations.length?<Table aria-label="我的工具服务"><TableHeader><TableRow><TableHead>服务</TableHead><TableHead>组织权限 / 服务状态</TableHead><TableHead>客户端授权</TableHead></TableRow></TableHeader><TableBody>{model.installations.map(row=>{
      const clients=model.consents.filter(client=>client.installation===row.id);
      return <TableRow key={row.id} data-state={selectedId===row.id?"selected":undefined}>
        <TableCell><TaskLink href={runtimeMemberHref(row.id)} current={selectedId===row.id}><strong>{row.label}</strong></TaskLink></TableCell>
        <TableCell>有使用权限<Badge>{installationState[row.state]}</Badge></TableCell>
        <TableCell>{clients.length?`${clients.length} 个已记录授权`:"尚无客户端授权"}</TableCell>
      </TableRow>;
    })}</TableBody></Table>:<p className="empty">目前没有获准使用的工具服务。请联系管理员；重复登录不会增加权限。</p>}
    {!selectedId?<ClientConsents model={model}/>:null}
  </section>;
  const task=selected?<section className="runtime-detail" id="runtime-detail" tabIndex={-1} aria-label={`${selected.label} 配置与连接`}>
    <header className="task-card-head"><h2 className="task-title">{selected.label}</h2><TaskClose href={runtimeMemberHref()}/></header>
    <dl className="data-list"><div><dt>组织权限</dt><dd>已授予{selected.access_expires_at?`，${utc(selected.access_expires_at)} 到期`:""}</dd></div>
      <div><dt>服务状态</dt><dd>{installationState[selected.state]}</dd></div><div><dt>上游凭据</dt><dd>{selected.phase!=="ready"?"管理员正在处理凭据，当前不可用":selected.credential_ready?"已保存，未进行上游健康探测":"尚未配置，请联系管理员"}</dd></div></dl>
    {selected.state!=="enabled"||selected.phase!=="ready"||!selected.credential_ready?<p role="status">当前服务不可调用，请由管理员处理。重新做 OAuth 登录不能修复上游连接。</p>:null}
    <section className="workspace-section" aria-label="Codex MCP 配置"><h3>配置 Codex</h3><p>将下面的 URL 配置合并到 <code>.codex/config.toml</code>（受信任项目）或 <code>~/.codex/config.toml</code>。先检查已有配置，不要覆盖其他选项。</p>
      <pre>{`[mcp_servers.${selected.id}]\nurl = ${JSON.stringify(selected.resource)}\n`}</pre>
      <p>{selected.state==="enabled"&&selected.phase==="ready"&&selected.credential_ready?"在终端完成原生授权：":"服务恢复可用后，再在终端授权："}</p><pre>{`codex mcp login ${selected.id}`}</pre>
      <p className="caption">已验证 Codex CLI 0.156.1。URL 文件可以提交到项目；本地 OAuth token 仍是敏感凭据，由客户端保存，不要提交或共享。配置文件本身不授予使用权限。</p>
      <p>使用的是组织共享上游账号。工具可能读取或修改共享资源，Agency Relay 不提供工具级只读或对象隔离。</p>
    </section>
    <ClientConsents model={model} installation={selected}/>
    <section className="workspace-section" aria-label="最近传输"><h3>最近传输</h3>{fact?<><p><time dateTime={fact.finished_at}>{utc(fact.finished_at)}</time> · {fact.attempted?`上游 HTTP ${fact.upstream_status??"未记录"}`:"未向上游发送"} · {fact.terminal==="completed"?"传输结束":fact.terminal==="cancelled"?"传输取消":"传输异常"}</p>
      <p className="caption">时长 {fact.duration_ms} ms · 请求已观测 {fact.request_bytes_observed} bytes · 响应已观测 {fact.response_bytes_observed} bytes{fact.authority_revision!==selected.authority_revision?" · 旧权限版本的记录":""}</p>
      {fact.error?<p role="status">{fact.error==="upstream_credential_unavailable"?"上游凭据不可用，请联系管理员，不需要反复登录。":"传输没有正常结束。先查看当前授权与服务状态，不会自动重试工具操作。"}</p>:null}</>:<p>尚无传输记录。</p>}
      <p className="caption">HTTP 状态和传输结束不是工具任务成功证明；这里不统计服务额度、模型用量或金额。</p>
    </section>
  </section>:selectedId?<section className="gate" role="alert"><h2>没有这个工具服务</h2><p>该服务不存在或你目前无使用权限。不会选择另一个服务。</p><a href={runtimeMemberHref()}>查看我的工具服务</a></section>:null;
  return <ObjectWorkspace collection={collection} task={task}/>;
}

export const runtimeAdminHref=(id?:string,search="",page=1)=>`/admin?view=runtime${id?`&installation=${encodeURIComponent(id)}`:""}${search?`&q=${encodeURIComponent(search)}`:""}${page>1?`&page=${page}`:""}`;
type Installation=RuntimeAdminModel["installations"][number];
function RuntimeAction({installation,action,label,message,details,children,className,variant="outline"}:{readonly installation:Installation;readonly action:string;readonly label:string;readonly message:string;readonly details?:string;readonly children?:import("react").ReactNode;readonly className?:string;readonly variant?:"outline"|"default"|"destructive"}) {
  const confirmation=`${installation.label}：${message}`;const confirmationDetails=`${installation.resource}。${details??""}`;
  return <form className={className} method="post" action={`/admin/ui/runtime-installations/${installation.id}`} data-confirmation={confirmation} data-confirmation-details={confirmationDetails}>
    <input type="hidden" name="action" value={action}/><input type="hidden" name="confirm" value="1"/>
    {action!=="configure"?<><input type="hidden" name="expectedRevision" value={installation.revision}/><input type="hidden" name="operationId" value={action==="recover"?installation.operation_id??"":crypto.randomUUID()}/></>:null}
    {children}<ConfirmationFallback message={confirmation} details={confirmationDetails}/><Button type="submit" variant={variant}>{label}</Button>
  </form>;
}
function RuntimePathField({installation}:{readonly installation:Installation}) {
  const description=`runtime-path-${installation.id}`;
  return <><Field control={{label:"服务路径",name:"path",value:new URL(installation.resource).pathname,maxLength:65,
    pattern:"/[a-z][a-z0-9\\-]{0,63}",describedBy:description,required:true}}/>
    <p className="caption" id={description}>以 / 和小写字母开头。随后可用小写字母、数字和连字符。</p></>;
}

export function RuntimeAdminPage({model}:{readonly model:RuntimeAdminModel}) {
  const selected=model.installations.find(row=>row.id===model.selectedId);
  const editable=selected&&selected.phase==="ready"&&selected.state!=="unconfigured"&&selected.state!=="retired";
  return <div className="runtime-admin-workspace">
    <nav className="runtime-installation-picker" id="runtime-installations" aria-label="已审查的工具服务">
      {model.installations.map(row=><TaskLink key={row.id} href={runtimeAdminHref(row.id)} current={row.id===model.selectedId} className="runtime-installation-choice"><strong>{row.label}</strong><Badge>{row.state==="unconfigured"?"尚未配置":installationState[row.state]}</Badge>{row.phase!=="ready"?<span className="record-subline">{row.phase==="writing"?"写入未确认":"清理待完成"}</span>:null}</TaskLink>)}
    </nav>
    {!model.installations.length?<p className="empty">还没有工具服务。工具服务由部署配置提供，每个服务需要明确的访问地址和上游凭据。</p>:null}
    {selected?<section className="runtime-admin-detail" id="runtime-detail" tabIndex={-1} aria-label={`${selected.label} 管理`}>
      <header className="runtime-installation-head">{editable?<RuntimeAction className="runtime-name-form" installation={selected} action="rename" label="保存名称" message="更改显示名称？" details="服务地址和上游权限不变。"><Field control={{label:"服务名称",name:"label",value:selected.label,maxLength:64,required:true}}/></RuntimeAction>:<h2>{selected.label}</h2>}<div className="runtime-installation-actions"><Badge data-tone={selected.state==="enabled"?"ok":undefined}>{selected.state==="unconfigured"?"尚未配置":installationState[selected.state]}</Badge>
        {editable&&selected.state==="enabled"?<RuntimeAction installation={selected} action="disable" label="停用服务" message="停用此服务？后续调用被拒绝，旧客户端授权失效。" details="凭据与成员权限保留；重新启用后客户端需要重新授权。"/>:editable&&selected.credential_ready?<RuntimeAction installation={selected} action="enable" label="启用服务" message="启用此服务？获准成员可使用团队共享上游账号的工具。" details="成员通过 OAuth 授权使用。启用不是上游健康或任务成功证明。"/>:null}
      </div></header>
      <dl className="runtime-installation-facts"><div className="runtime-resource"><dt>{selected.state==="unconfigured"?"建议地址":"服务地址"}</dt><dd><code>{selected.resource}</code></dd></div><div><dt>上游凭据</dt><dd>{selected.credential_ready?"已保存 · 未探测":"不可用或未确认"}</dd></div><div><dt>凭据请求头</dt><dd><code>{selected.credential_header}</code></dd></div></dl>
      <p className="caption runtime-installation-diagnostics">{selected.profile} · 配置版本 {selected.revision} · 权限版本 {selected.authority_revision}</p>
      {selected.phase!=="ready"?<section className="runtime-recovery" aria-label="服务恢复"><p role="alert">{selected.phase==="writing"?"凭据写入结果未确认。不要重新提交凭据。当前无法调用服务。":"权限变更已记录，但旧凭据清理待完成。当前无法调用服务。"}</p><RuntimeAction installation={selected} action="recover" label={selected.phase==="writing"?"放弃未确认凭据并停用":"重试清理"} message={selected.phase==="writing"?"放弃这次凭据写入？服务将停用，旧客户端授权失效。":"继续当前版本的凭据清理？"} details={selected.phase==="writing"?"全部凭据会被清除；不会重复写入候选凭据。":"不重新写入凭据，不恢复旧授权。"}/></section>:selected.state==="unconfigured"?<section className="runtime-recovery" aria-label="建立服务配置"><p>建立配置后，再绑定上游凭据并授予成员权限。</p><RuntimeAction installation={selected} action="configure" label="建立配置" message="建立此已审查服务的配置？" details="初始状态为停用，尚无上游凭据和成员权限。">{selected.editable_path?<RuntimePathField installation={selected}/>:null}</RuntimeAction></section>:selected.state==="retired"?<p role="status">服务已退役。此服务的路径仍保留，无法再次启用。</p>:!selected.credential_ready?<p className="runtime-recovery" role="status">先绑定上游凭据，再启用服务。</p>:null}
      {selected.state!=="unconfigured"?<div className="runtime-admin-columns">
        <section className="runtime-member-access" aria-label="成员使用权限"><header className="runtime-section-head"><h3>成员使用权限</h3><span className="caption">{selected.profile==="lark.doc"?"共享飞书应用权限 · 读取文档":"共享上游账号 · 可写入"}</span></header>
          <form method="get" action="/admin" role="search" aria-label="搜索可授权成员" data-dashboard-search="true" className="runtime-member-search"><input type="hidden" name="view" value="runtime"/><input type="hidden" name="installation" value={selected.id}/><Field control={{label:"组织邮箱或成员 ID",name:"q",value:model.search,maxLength:256}}/><Button type="submit" variant="outline">搜索成员</Button></form>
          <Table className="runtime-member-table" aria-label="成员工具权限"><TableHeader><TableRow><TableHead>成员</TableHead><TableHead>组织权限</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{model.members.map(member=>{
            const confirmation=member.state==="granted"?`撤回 ${member.canonical_email??member.id} 的「${selected.label}」使用权限？后续调用被拒绝。`:`授予 ${member.canonical_email??member.id} 不设期限的「${selected.label}」使用权限？可使用团队共享上游账号的工具。`;
            const confirmationDetails=`${selected.resource}。${member.state==="granted"?"保留记录，不影响其他成员和浏览器登录。":"通过 OAuth 使用，不保证资源隔离。"}`;
            return <TableRow key={member.id}><TableCell>{member.canonical_email??member.id}{member.status!=="active"?<span className="record-subline">成员已停用</span>:null}</TableCell><TableCell><Badge>{member.state==="granted"?"已授予":"未授予"}</Badge>{member.state==="granted"?<span className="record-subline">{member.expires_at?`${utc(member.expires_at)} 到期`:"不设期限"}</span>:null}</TableCell><TableCell>{selected.state!=="retired"&&selected.phase==="ready"?<form method="post" action={`/admin/ui/runtime-installations/${selected.id}`} data-confirmation={confirmation} data-confirmation-details={confirmationDetails}><input type="hidden" name="action" value="access"/><input type="hidden" name="confirm" value="1"/><input type="hidden" name="subject" value={member.id}/><input type="hidden" name="expectedRevision" value={member.revision}/><input type="hidden" name="state" value={member.state==="granted"?"revoked":"granted"}/><input type="hidden" name="expiresAt" value=""/><ConfirmationFallback message={confirmation} details={confirmationDetails}/><Button type="submit" variant={member.state==="granted"?"outline":"default"}>{member.state==="granted"?"撤回权限":"授予权限"}</Button></form>:"当前不可修改"}</TableCell></TableRow>;
          })}</TableBody></Table>
          {!model.members.length?<p className="empty">没有匹配的成员。</p>:null}<nav className="runtime-member-pagination" aria-label="成员分页">{model.page>1?<TaskLink href={runtimeAdminHref(selected.id,model.search,model.page-1)}>上一页</TaskLink>:null}{model.more?<TaskLink href={runtimeAdminHref(selected.id,model.search,model.page+1)}>下一页</TaskLink>:null}</nav>
        </section>
        {editable?<aside className="runtime-configuration" aria-label="服务配置">
          {selected.editable_path?<section className="runtime-credential-panel" aria-label="服务路径">
            <h3>服务路径</h3>
            <RuntimeAction installation={selected} action="path" label="保存路径" message="更改服务路径？旧地址将关闭，已有客户端授权失效。" details="获准成员需要在客户端更新地址并重新授权。旧路径继续保留。"><RuntimePathField installation={selected}/></RuntimeAction>
          </section>:null}<section className="runtime-credential-panel" aria-label="上游凭据"><header className="runtime-section-head"><h3>上游凭据</h3><span className="caption">凭据只写</span></header>
          {selected.profile==="lark.doc"?<>
            <p className="caption">使用获准读取文档的飞书应用。Relay 会自动获取和更新应用令牌。</p>
            <RuntimeAction installation={selected} action="supply" label="保存飞书应用" variant="default" message="保存飞书应用凭据？已有客户端授权将失效。" details="成员保留工具服务使用权限，客户端需要重新授权。">
              <input type="hidden" name="authority" value="rebind"/>
              <Field control={{label:"凭据请求头名",name:"credentialHeader",value:selected.credential_header,required:true,maxLength:64}}/>
              <Field control={{label:"App ID",name:"appId",required:true,autoComplete:"off",maxLength:128}}/>
              <Field control={{label:"App Secret",name:"appSecret",type:"password",required:true,autoComplete:"off",maxLength:256}}/>
            </RuntimeAction>
          </>:<div className="runtime-credential-editor">
            {selected.credential_ready?<fieldset className="runtime-credential-modes"><legend className="sr-only">凭据操作</legend><label><input type="radio" name={`credential-mode-${selected.id}`} value="same" defaultChecked/>同一上游账号</label><label><input type="radio" name={`credential-mode-${selected.id}`} value="rebind"/>更改请求头或账号</label></fieldset>:null}
            {selected.credential_ready?<div data-credential-mode="same"><RuntimeAction installation={selected} action="supply" label="更新凭据" variant="default" message="确认新凭据仍属于同一上游账号及同一权限？" details="保存后清理旧凭据，已有客户端授权保留。不要将不同上游账号当成材料轮换。"><input type="hidden" name="authority" value="same"/><Field control={{label:"新的凭据",name:"material",type:"password",required:true,autoComplete:"off",maxLength:4096}}/></RuntimeAction></div>:null}
            <div data-credential-mode="rebind"><RuntimeAction installation={selected} action="supply" label="绑定上游凭据" variant="default" message="保存请求头和凭据？旧客户端授权将失效。" details="旧上游资源和历史不会迁移。启用后获准成员使用新上游账号的共享工具权限。"><input type="hidden" name="authority" value="rebind"/><Field control={{label:"凭据请求头名",name:"credentialHeader",value:selected.credential_header,required:true,maxLength:64}}/><Field control={{label:"上游凭据",name:"material",type:"password",required:true,autoComplete:"off",maxLength:4096}}/></RuntimeAction></div>
          </div>}
        </section><section className="runtime-retirement" aria-label="退役服务"><RuntimeAction installation={selected} action="retire" label="永久退役服务" variant="destructive" message="永久退役此服务？不能重新启用，客户端授权立即失效。" details="后续调用被拒绝并清理上游凭据；不撤回已执行的上游操作。"/></section></aside>:null}
      </div>:null}
    </section>:model.selectedId?<Card className="workspace-section" data-runtime-missing=""><h2>没有这个工具服务</h2><p className="caption">这个工具服务当前不可用。</p><TaskLink className="action-link" href={runtimeAdminHref()}>查看工具服务</TaskLink></Card>:model.installations.length?<p className="empty">选择一个工具服务，管理成员权限与上游凭据。</p>:null}
  </div>;
}
