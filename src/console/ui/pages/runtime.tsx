import type {RuntimeMemberModel} from "../../../runtime/oauth";
import {Button} from "../components/button";
import {Badge} from "../components/badge";
import {Card} from "../components/card";
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from "../components/table";
import {TaskLink} from "../chrome";
import {ConfirmationFallback} from "../fields";
import {Field} from "../fields";
import {formatNumber} from "../../format";
import {runtimeAdminHref,runtimeMemberHref,type RuntimeMemberSection,type RuntimeSection} from "../../runtime-location";
import {Icon} from "../icon";
import type {RuntimeAdminModel} from "../../../runtime/console";
import {larkHostedTools,larkToolGroups,larkToolIdentities,larkToolsByName} from "../../../runtime/connectors/lark-doc/profile";
import {NativeFeishuToolTree,type FeishuGroup} from "../feishu-tool-tree";
import {larkPermissionMessage} from "../../../runtime/connectors/lark-doc/permissions";

export {runtimeMemberHref};
const installationState={enabled:"已启用",disabled:"已停用",retired:"已退役"};
const utc=(value:string)=>`${value.slice(0,19).replace("T"," ")} UTC`;

function ClientConsents({model,installation}:{readonly model:RuntimeMemberModel;readonly installation?:RuntimeMemberModel["installations"][number]}) {
  const clients=installation?model.consents.filter(client=>client.installation===installation.id):model.consents;
  return <section className={installation ? "runtime-member-panel" : "workspace-section"} aria-label="客户端授权">{installation ? <h2>客户端授权</h2> : null}{!clients.length?<p>尚无客户端授权。完成终端登录并在授权页确认客户端、服务和权限。</p>:<Table aria-label="已记录的客户端授权"><TableHeader><TableRow><TableHead>客户端 / 服务</TableHead><TableHead>授权状态</TableHead><TableHead>到期（UTC）</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{clients.map(client=>{
    const currentInstallation=model.installations.find(row=>row.id===client.installation);
    const current=currentInstallation&&client.scope==="runtime.use"&&client.authority_revision===currentInstallation.authority_revision&&client.access_revision===currentInstallation.access_revision;
    const message=`撤销 ${client.client_name} 的客户端授权？后续请求将被拒绝。`;const details=`${client.resource}。不会退出浏览器、撤销其他客户端或撤回已执行的上游操作。`;
    return <TableRow key={client.id}><TableCell className="whitespace-normal">{client.client_name}<span className="record-subline">{currentInstallation?.label??"已无使用权限的服务"} · 名称由客户端自行提供</span></TableCell><TableCell className="whitespace-normal">{current?"已记录授权，未检查凭据":currentInstallation?"服务权限已变更，需要重新授权":"已无组织权限，后续调用被拒绝"}</TableCell><TableCell><time dateTime={client.expires_at}>{utc(client.expires_at)}</time></TableCell><TableCell>
      <form className="member-form" method="post" action={`/me/ui/runtime-clients/${encodeURIComponent(client.id)}/revoke`} data-confirmation={message} data-confirmation-details={details}><input type="hidden" name="installation" value={client.installation}/><input type="hidden" name="confirm" value="1"/><ConfirmationFallback message={message} details={details}/><Button type="submit" variant="outline">撤销授权</Button></form>
    </TableCell></TableRow>;
  })}</TableBody></Table>}
  <p className="caption">退出浏览器不撤销这些授权。管理员撤回组织权限或停用服务会拒绝后续调用；凭据退役由管理员处理。本地 token 过期、撤销或丢失时，在权限仍有效的前提下重新执行终端登录。</p></section>;
}

type MemberInstallation = RuntimeMemberModel["installations"][number];
const memberSections = [
  ["configuration", "接入配置"], ["clients", "客户端授权"], ["diagnostics", "诊断"]
] as const;

function RuntimeServiceList({model}: {readonly model: RuntimeMemberModel}) {
  return <section className="runtime-collection" aria-labelledby="runtime-installations-title" id="runtime-installations">
    <header className="page-head">
      <h1 id="runtime-installations-title">我的工具服务</h1>
      {model.installations.length ? <p>选择一个服务，查看配置和授权。</p> : null}
    </header>
    {model.installations.length ?
      <ul className="runtime-service-list" aria-label="可用工具服务">{model.installations.map(row =>
        <li className="runtime-service-item" key={row.id}>
          <div><h2>{row.label}</h2><p className="caption">{installationState[row.state]} · 有使用权限</p></div>
          <Button asChild variant="outline"><a href={runtimeMemberHref(row.id)}>打开{row.personal_feishu ? "" : " "}{row.label}<Icon name="arrow" /></a></Button>
        </li>
      )}</ul> : <p className="empty">目前没有获准使用的工具服务。请联系管理员；重复登录不会增加权限。</p>}
    <details className="runtime-member-panel">
      <summary>所有客户端授权{model.consents.length ? `（${model.consents.length}）` : ""}</summary>
      <ClientConsents model={model} />
    </details>
  </section>;
}

function FeishuAccountActions({installation}: {readonly installation: MemberInstallation}) {
  const action = `/runtime/feishu-user/${encodeURIComponent(installation.id)}`;
  if (installation.personal_feishu === "app_required") return <p className="runtime-member-panel">管理员绑定飞书应用后，可使用自己的飞书账号授权工具。</p>;
  if (!installation.personal_feishu) return null;
  if (installation.personal_feishu === "connected") return <details className="runtime-member-panel">
    <summary>管理飞书账号</summary>
    <p>Relay 会在调用时刷新令牌。需要新增权限时，可更新授权。</p>
    <form className="runtime-feishu-actions" method="post" action={`${action}/connect`}>
      <Button type="submit" variant="outline">更新飞书授权</Button>
      <Button type="submit" variant="outline" formAction={`${action}/disconnect`}>断开飞书账号</Button>
    </form>
  </details>;
  return <section className="runtime-member-panel" aria-labelledby="runtime-feishu-connect-title">
    <h2 id="runtime-feishu-connect-title">连接飞书账号</h2>
    <p>连接自己的飞书账号，即可用成员身份执行获准的工具操作。</p>
    <form className="runtime-feishu-actions" method="post" action={`${action}/connect`}><Button type="submit">连接飞书账号</Button></form>
  </section>;
}

function RuntimeSnippet({text, label}: {readonly text: string; readonly label: string}) {
  return <div data-runtime-snippet="">
    <div className="runtime-member-snippet">
      <pre><code>{text}</code></pre>
      <Button type="button" variant="outline" data-runtime-copy="" hidden>{label}</Button>
    </div>
    <span role="status" className="caption" />
  </div>;
}

function RuntimeMemberConfiguration({installation, ready}: {readonly installation: MemberInstallation; readonly ready: boolean}) {
  return <>
    {ready && installation.personal_feishu !== "connected" ? <FeishuAccountActions installation={installation} /> : null}
    <section className="runtime-member-panel" aria-label="Codex MCP 配置">
      <h2>配置 Codex</h2>
      <ol className="runtime-setup-steps">
        <li><strong>合并 MCP 配置</strong>
          <p>合并到 <code>~/.codex/config.toml</code> 或受信任项目的 <code>.codex/config.toml</code>，保留已有配置。</p>
          <RuntimeSnippet label="复制配置" text={`[mcp_servers.${installation.id}]\nurl = ${JSON.stringify(installation.resource)}\n`} />
        </li>
        <li><strong>在终端授权</strong>
          <p>{ready ? "在终端运行命令，并在授权页核对客户端、服务和权限。" : "服务恢复可用后，再在终端授权。"}</p>
          <RuntimeSnippet label="复制命令" text={`codex mcp login ${installation.id}`} />
        </li>
      </ol>
      <p className="caption">已验证 Codex CLI 0.156.1。配置文件本身不授予使用权限。本地 OAuth token 是敏感凭据，由客户端保存，请勿提交或共享。</p>
      <p className="caption">{installation.personal_feishu ? "管理员调整工具后，请在客户端刷新工具列表。如果飞书权限不足，请更新飞书账号授权。" : "使用的是组织共享上游账号。工具可能读取或修改共享资源，Agency Relay 不提供工具级只读或对象隔离。"}</p>
    </section>
    {ready && installation.personal_feishu === "connected" ? <FeishuAccountActions installation={installation} /> : null}
  </>;
}

function RuntimeMemberDiagnostics({model, installation}: {readonly model: RuntimeMemberModel; readonly installation: MemberInstallation}) {
  const fact = model.activity.find(row => row.installation === installation.id);
  return <section className="runtime-member-panel" aria-label="最近传输">
    <h2>最近传输</h2>
    {fact ? <>
      <p><time dateTime={fact.finished_at}>{utc(fact.finished_at)}</time> · {fact.attempted ? `上游 HTTP ${fact.upstream_status ?? "未记录"}` : "未向上游发送"} · {fact.terminal === "completed" ? "传输结束" : fact.terminal === "cancelled" ? "传输取消" : "传输异常"}</p>
      <p className="caption">时长 {formatNumber(fact.duration_ms)} ms · 请求已观测 {formatNumber(fact.request_bytes_observed)} bytes · 响应已观测 {formatNumber(fact.response_bytes_observed)} bytes{fact.authority_revision !== installation.authority_revision ? " · 旧权限版本的记录" : ""}</p>
      {fact.feishu_permissions?.length ? <ul aria-label="飞书权限提示">{fact.feishu_permissions.map(notice =>
        <li key={`${notice.tool}:${notice.kind}`}>{larkPermissionMessage(notice)}</li>)}</ul> :
        fact.error ? <p role="status">{fact.error === "lark_user_authorization_required" ? "请连接飞书账号并检查该工具所需的权限。" : fact.error === "upstream_credential_unavailable" ? "上游凭据不可用，请联系管理员，不需要反复登录。" : "传输没有正常结束。先查看当前授权与服务状态，不会自动重试工具操作。"}</p> : null}
      {installation.personal_feishu && (fact.feishu_permissions?.length || fact.error === "lark_user_authorization_required") ?
        <Button asChild variant="outline"><a href={runtimeMemberHref(installation.id)}>查看飞书账号授权</a></Button> : null}
    </> : <p>尚无传输记录。</p>}
    <p className="caption">上游凭据{installation.phase !== "ready" ? "正在由管理员处理，当前不可用" : installation.credential_ready ? "已保存，未进行上游健康探测" : "尚未配置，请联系管理员"}。</p>
    <p className="caption">HTTP 状态和传输结束不是工具任务成功证明；这里不统计服务额度、模型用量或金额。</p>
  </section>;
}

export function RuntimeMemberPage({model,selectedId,section}: {readonly model: RuntimeMemberModel; readonly selectedId: string | null; readonly section: RuntimeMemberSection}) {
  if (!selectedId) return <RuntimeServiceList model={model} />;
  const selected = model.installations.find(row => row.id === selectedId);
  if (!selected) return <section className="gate" role="alert">
    <h1>没有这个工具服务</h1><p>该服务不存在或你目前无使用权限。</p><a href={runtimeMemberHref()}>查看我的工具服务</a>
  </section>;
  const ready = selected.state === "enabled" && selected.phase === "ready" && selected.credential_ready;
  const feishuStatus = selected.personal_feishu === "connected" ? "已连接" : selected.personal_feishu === "app_required" ? "等待管理员配置" : "未连接";
  return <section className="runtime-detail" id="runtime-detail" aria-labelledby="runtime-detail-title">
    <header className="runtime-member-heading">
      <Button asChild variant="outline"><a href={runtimeMemberHref()}><Icon name="back" />返回我的工具服务</a></Button>
      <h1 id="runtime-detail-title">{selected.label}</h1>
    </header>
    <dl className="runtime-member-facts">
      <div><dt>组织权限</dt><dd>已授予{selected.access_expires_at ? `，${utc(selected.access_expires_at)} 到期` : ""}</dd></div>
      <div><dt>服务状态</dt><dd>{installationState[selected.state]}</dd></div>
      {selected.personal_feishu ? <div><dt>飞书账号</dt><dd>{feishuStatus}</dd></div> : null}
    </dl>
    {!ready ? <p className="runtime-recovery" role="status">当前服务不可调用，请由管理员处理。重新做 OAuth 登录不能修复上游连接。</p> : null}
    <nav data-slot="tabs-list" data-variant="line" aria-label="工具服务详情">
      {memberSections.map(([id, label]) => <a key={id} data-slot="tabs-trigger" aria-current={section === id ? "page" : undefined}
        href={runtimeMemberHref(selected.id, id)}>{label}</a>)}
    </nav>
    {section === "configuration" ? <RuntimeMemberConfiguration installation={selected} ready={ready} /> : null}
    {section === "clients" ? <ClientConsents model={model} installation={selected} /> : null}
    {section === "diagnostics" ? <RuntimeMemberDiagnostics model={model} installation={selected} /> : null}
  </section>;
}

type Installation=RuntimeAdminModel["installations"][number];
function RuntimeAction({installation,action,label,message,details,children,className,variant="outline"}:{readonly installation:Installation;readonly action:string;readonly label?:string;readonly message:string;readonly details?:string;readonly children?:import("react").ReactNode;readonly className?:string;readonly variant?:"outline"|"default"|"destructive"}) {
  const confirmation=`${installation.label}：${message}`;const confirmationDetails=`${installation.resource}。${details??""}`;
  const draft=action==="rename"||action==="path"||action==="tools";
  return <form className={className} autoComplete={draft?"off":undefined} data-dashboard-draft={draft?`runtime-${action}`:undefined}
    data-draft-scope={draft?String(installation.revision):undefined} method="post" action={`/admin/ui/runtime-installations/${encodeURIComponent(installation.id)}`} data-confirmation={confirmation} data-confirmation-details={confirmationDetails}>
    <input type="hidden" name="action" value={action}/><input type="hidden" name="confirm" value="1"/>
    {action!=="configure"?<><input type="hidden" name="expectedRevision" value={installation.revision}/><input type="hidden" name="operationId" value={action==="recover"?installation.operation_id??"":crypto.randomUUID()}/></>:null}
    {label ? <>{children}<ConfirmationFallback message={confirmation} details={confirmationDetails}/><Button type="submit" variant={variant}>{label}</Button></>
      : <><ConfirmationFallback message={confirmation} details={confirmationDetails}/>{children}</>}
  </form>;
}
function RuntimePathField({installation}:{readonly installation:Installation}) {
  const description=`runtime-path-${installation.id}`;
  return <><Field control={{label:"服务路径",name:"path",value:new URL(installation.resource).pathname,maxLength:65,
    pattern:"/[a-z][a-z0-9\\-]{0,63}",describedBy:description,required:true}}/>
    <p className="caption" id={description}>以 / 和小写字母开头。随后可用小写字母、数字和连字符。</p></>;
}

const feishuDomainTitles: Readonly<Record<string,string>> = {
  docx:"云文档", wiki:"知识库", bitable:"多维表格", calendar:"日历", contact:"通讯录", im:"消息",
  drive:"云空间", sheets:"电子表格", task:"任务", approval:"审批", minutes:"妙记", mail:"邮箱",
};
const hostedToolOrder = new Map(["search-doc","fetch-doc","search-user","add-comments","list-docs","get-user"]
  .map((name,index)=>[name,index]));

function FeishuToolSelection({installation,domains}:{readonly installation:Installation;readonly domains:NonNullable<RuntimeAdminModel["openApiDomains"]>}) {
  const enabled=new Set(installation.feishu_tools);
  const domainsByName=new Map(domains);
  const orderedDomains=[...Object.keys(feishuDomainTitles).flatMap(name=>{
    const tools=domainsByName.get(name);
    return tools?[[name,tools] as const]:[];
  }),...domains.filter(([name])=>!Object.hasOwn(feishuDomainTitles,name))];
  const groups:FeishuGroup[]=[{
    name:"hosted",title:"飞书托管工具",
    tools:[...larkHostedTools].sort((a,b)=>(hostedToolOrder.get(a.name)??hostedToolOrder.size)-(hostedToolOrder.get(b.name)??hostedToolOrder.size)).map(tool=>({
      name:tool.name,title:tool.label,description:tool.group?larkToolGroups[tool.group]:undefined,
      scopes:[...tool.scopes],supplementalScopes:tool.supplementalScopes?[...tool.supplementalScopes]:undefined,
      authority:`${tool.writes?"写入 · ":""}${larkToolIdentities[tool.identity]}`,enabled:enabled.has(tool.name),
    })),
  },...orderedDomains.map(([name,tools])=>({name,title:feishuDomainTitles[name]??name,tools:tools.map(tool=>{
    const executable=larkToolsByName.get(tool.name);
    return {name:tool.name,title:tool.name,description:tool.description,docsUrl:tool.docsUrl,scopes:tool.scopes,alternatives:tool.alternatives,
      authority:executable?`${executable.highRisk?"高风险写入 · ":executable.writes?"写入 · ":""}${larkToolIdentities[executable.identity]}`
        :tool.scopes.length?"当前执行方式未接入":"核实应用权限后可接入",
      enabled:executable?enabled.has(tool.name):undefined};
  })}))];
  return <section className="feishu-tools-section" aria-labelledby="feishu-tools-title">
    <div className="feishu-tools-intro">
      <h3 id="feishu-tools-title">飞书工具</h3>
      <p>选择客户端可使用的飞书工具。保存后，已授权的客户端刷新列表即可看到更新。</p>
    </div>
    <RuntimeAction installation={installation} action="tools" message="保存飞书工具设置？"
      details="关闭的工具会停止接受新调用。已授权的客户端可使用新增工具，Relay 仍会检查飞书权限。">
      <NativeFeishuToolTree groups={groups}/>
    </RuntimeAction>
  </section>;
}

export function RuntimeAdminPage({model}:{readonly model:RuntimeAdminModel}) {
  const selected=model.installations.find(row=>row.id===model.selectedId);
  const editable=selected&&selected.phase==="ready"&&selected.state!=="unconfigured"&&selected.state!=="retired";
  const feishu=selected?.profile==="lark.doc";
  const sections: {id:RuntimeSection;label:string}[]=[{id:"settings",label:"服务配置"}];
  if(selected&&selected.state!=="unconfigured")sections.push({id:"members",label:"成员权限"});
  if(editable&&feishu)sections.push({id:"tools",label:"工具权限"});
  return <div className="runtime-admin-workspace">
    <nav className="runtime-installation-picker" id="runtime-installations" aria-label="已审查的工具服务">
      {model.installations.map(row=><TaskLink key={row.id} href={runtimeAdminHref(row.id)} current={row.id===model.selectedId} className="runtime-installation-choice"><strong>{row.label}</strong><Badge>{row.state==="unconfigured"?"尚未配置":installationState[row.state]}</Badge>{row.phase!=="ready"?<span className="record-subline">{row.phase==="writing"?"写入未确认":"清理待完成"}</span>:null}</TaskLink>)}
    </nav>
    {!model.installations.length?<p className="empty">还没有工具服务。工具服务由部署配置提供，每个服务需要明确的访问地址和上游凭据。</p>:null}
    {selected?<section className="runtime-admin-detail" id="runtime-detail" tabIndex={-1} aria-label={`${selected.label} 管理`}>
      <div className="runtime-installation-summary">
      <header className="runtime-installation-head"><h2>{selected.label}</h2><div className="runtime-installation-actions"><Badge data-tone={selected.state==="enabled"?"ok":undefined}>{selected.state==="unconfigured"?"尚未配置":installationState[selected.state]}</Badge>
        {editable&&selected.state==="enabled"?<RuntimeAction installation={selected} action="disable" label="停用服务" message="停用此服务？后续调用被拒绝，旧客户端授权失效。" details="凭据与成员权限保留；重新启用后客户端需要重新授权。"/>:editable&&selected.credential_ready?<RuntimeAction installation={selected} action="enable" label="启用服务" message={feishu?"启用此服务？获准成员可申请使用所选飞书工具。":"启用此服务？获准成员可使用团队共享上游账号的工具。"} details="成员通过 OAuth 授权使用。启用不是上游健康或任务成功证明。"/>:null}
      </div></header>
      <dl className="runtime-installation-facts"><div className="runtime-resource"><dt>{selected.state==="unconfigured"?"建议地址":"服务地址"}</dt><dd><code>{selected.resource}</code></dd></div><div><dt>上游凭据</dt><dd>{selected.credential_ready?"已保存 · 未探测":"不可用或未确认"}</dd></div><div><dt>凭据请求头</dt><dd><code>{selected.credential_header}</code></dd></div></dl>
      <p className="caption runtime-installation-diagnostics">{selected.profile} · 配置版本 {selected.revision} · 权限版本 {selected.authority_revision}</p>
      </div>
      {selected.phase!=="ready"?<section className="runtime-recovery" aria-label="服务恢复"><p role="alert">{selected.phase==="writing"?"凭据写入结果未确认。不要重新提交凭据。当前无法调用服务。":"权限变更已记录，但旧凭据清理待完成。当前无法调用服务。"}</p><RuntimeAction installation={selected} action="recover" label={selected.phase==="writing"?"放弃未确认凭据并停用":"重试清理"} message={selected.phase==="writing"?"放弃这次凭据写入？服务将停用，旧客户端授权失效。":"继续当前版本的凭据清理？"} details={selected.phase==="writing"?"全部凭据会被清除；不会重复写入候选凭据。":"不重新写入凭据，不恢复旧授权。"}/></section>:selected.state==="unconfigured"?<section className="runtime-recovery" aria-label="建立服务配置"><p>建立配置后，再绑定上游凭据并授予成员权限。</p><RuntimeAction installation={selected} action="configure" label="建立配置" message="建立此已审查服务的配置？" details="初始状态为停用，尚无上游凭据和成员权限。">{selected.editable_path?<RuntimePathField installation={selected}/>:null}</RuntimeAction></section>:selected.state==="retired"?<p role="status">服务已退役。此服务的路径仍保留，无法再次启用。</p>:!selected.credential_ready?<p className="runtime-recovery" role="status">先绑定上游凭据，再启用服务。{model.section!=="settings"?<> <TaskLink href={runtimeAdminHref(selected.id)}>打开服务配置</TaskLink></>:null}</p>:null}
      {sections.length>1?<nav data-slot="tabs-list" data-variant="line" aria-label="服务管理">
        {sections.map(section=><TaskLink key={section.id} data-slot="tabs-trigger"
          aria-current={model.section===section.id?"page":undefined}
          href={runtimeAdminHref(selected.id,section.id,section.id==="members"?model.search:"",section.id==="members"?model.page:1)}>{section.label}</TaskLink>)}
      </nav>:null}
      {model.section==="members"?
        <section className="runtime-member-access" aria-label="成员使用权限"><header className="runtime-section-head"><h3>成员使用权限</h3><span className="caption">{feishu?"按工具授权 · 优先成员身份":"共享上游账号 · 可写入"}</span></header>
          {!feishu?<p className="caption">获准成员使用共享上游账号。资源不按成员隔离。</p>:null}
          <form method="get" action="/admin" role="search" aria-label="搜索可授权成员" data-dashboard-search="true" className="runtime-member-search"><input type="hidden" name="view" value="runtime"/><input type="hidden" name="section" value="members"/><input type="hidden" name="installation" value={selected.id}/><Field control={{label:"组织邮箱或成员 ID",name:"q",value:model.search,maxLength:256}}/><Button type="submit" variant="outline">搜索成员</Button></form>
          <Table className="runtime-member-table" aria-label="成员工具权限"><TableHeader><TableRow><TableHead>成员</TableHead><TableHead>组织权限</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{model.members.map(member=>{
            const confirmation=member.state==="granted"?`撤回 ${member.canonical_email??member.id} 的「${selected.label}」使用权限？后续调用被拒绝。`:`授予 ${member.canonical_email??member.id} 不设期限的「${selected.label}」使用权限？${feishu?"可申请使用所选飞书工具。":"可使用团队共享上游账号的工具。"}`;
            const confirmationDetails=`${selected.resource}。${member.state==="granted"?"保留记录，不影响其他成员和浏览器登录。":feishu?"客户端需要通过 OAuth 授权所申请的工具。":"通过 OAuth 使用，不保证资源隔离。"}`;
            return <TableRow key={member.id}><TableCell>{member.canonical_email??member.id}{member.status!=="active"?<span className="record-subline">成员已停用</span>:null}</TableCell><TableCell><Badge>{member.state==="granted"?"已授予":"未授予"}</Badge>{member.state==="granted"?<span className="record-subline">{member.expires_at?`${utc(member.expires_at)} 到期`:"不设期限"}</span>:null}</TableCell><TableCell>{selected.state!=="retired"&&selected.phase==="ready"?<form method="post" action={`/admin/ui/runtime-installations/${encodeURIComponent(selected.id)}`} data-confirmation={confirmation} data-confirmation-details={confirmationDetails}><input type="hidden" name="action" value="access"/><input type="hidden" name="returnSearch" value={model.search}/><input type="hidden" name="returnPage" value={model.page}/><input type="hidden" name="confirm" value="1"/><input type="hidden" name="subject" value={member.id}/><input type="hidden" name="expectedRevision" value={member.revision}/><input type="hidden" name="state" value={member.state==="granted"?"revoked":"granted"}/><input type="hidden" name="expiresAt" value=""/><ConfirmationFallback message={confirmation} details={confirmationDetails}/><Button type="submit" variant={member.state==="granted"?"outline":"default"}>{member.state==="granted"?"撤回权限":"授予权限"}</Button></form>:"当前不可修改"}</TableCell></TableRow>;
          })}</TableBody></Table>
          {!model.members.length?<p className="empty">{model.search?"没有匹配的成员。":"还没有可授权的成员。"}</p>:null}<nav className="runtime-member-pagination" aria-label="成员分页">{model.page>1?<TaskLink href={runtimeAdminHref(selected.id,"members",model.search,model.page-1)}>上一页</TaskLink>:null}{model.more?<TaskLink href={runtimeAdminHref(selected.id,"members",model.search,model.page+1)}>下一页</TaskLink>:null}</nav>
        </section>:null}
        {model.section==="settings"&&editable?<section className="runtime-configuration" aria-label="服务配置">
          <section className="runtime-credential-panel" aria-label="服务名称">
            <RuntimeAction className="runtime-name-form" installation={selected} action="rename" label="保存名称" message="更改显示名称？" details="服务地址和上游权限不变。"><Field control={{label:"服务名称",name:"label",value:selected.label,maxLength:64,required:true}}/></RuntimeAction>
          </section>
          {selected.editable_path?<section className="runtime-credential-panel" aria-label="服务路径">
            <RuntimeAction installation={selected} action="path" label="保存路径" message="更改服务路径？旧地址将关闭，已有客户端授权失效。" details="获准成员需要在客户端更新地址并重新授权。旧路径继续保留。"><RuntimePathField installation={selected}/><p className="caption">更改路径后，旧地址关闭，已有客户端授权失效。</p></RuntimeAction>
          </section>:null}<section className="runtime-credential-panel" aria-label="上游凭据"><header className="runtime-section-head"><h3>上游凭据</h3><span className="caption">凭据只写</span></header>
          {feishu?<>
            <p className="caption">绑定具备所需权限的飞书应用。Relay 会自动刷新成员和应用令牌。</p>
            <RuntimeAction installation={selected} action="supply" label="保存飞书应用" variant="default" message="保存飞书应用凭据？已有客户端授权将失效。" details="成员保留工具服务使用权限，客户端需要重新授权。">
              <input type="hidden" name="authority" value="rebind"/>
              <Field control={{label:"凭据请求头名",name:"credentialHeader",value:selected.credential_header,required:true,maxLength:64}}/>
              <Field control={{label:"App ID",name:"appId",required:true,autoComplete:"off",maxLength:128}}/>
              <Field control={{label:"App Secret",name:"appSecret",type:"password",required:true,autoComplete:"off",maxLength:256}}/>
            </RuntimeAction>
          </>:<div className="runtime-credential-editor">
            {selected.credential_ready?<fieldset className="runtime-credential-modes"><legend className="sr-only">凭据操作</legend><label><input type="radio" name={`credential-mode-${selected.id}`} value="same" defaultChecked/>同一上游账号</label><label><input type="radio" name={`credential-mode-${selected.id}`} value="rebind"/>更改请求头或账号</label></fieldset>:null}
            {selected.credential_ready?<div data-credential-mode="same"><RuntimeAction installation={selected} action="supply" label="更新凭据" variant="default" message="确认新凭据仍属于同一上游账号及同一权限？" details="保存后清理旧凭据，已有客户端授权保留。不要将不同上游账号当成材料轮换。"><input type="hidden" name="authority" value="same"/><p className="caption">同一账号和权限下更新凭据，会保留已有客户端授权。</p><Field control={{label:"新的凭据",name:"material",type:"password",required:true,autoComplete:"off",maxLength:4096}}/></RuntimeAction></div>:null}
            <div data-credential-mode="rebind"><RuntimeAction installation={selected} action="supply" label="绑定上游凭据" variant="default" message="保存请求头和凭据？旧客户端授权将失效。" details="旧上游资源和历史不会迁移。启用后获准成员使用新上游账号的共享工具权限。"><input type="hidden" name="authority" value="rebind"/><p className="caption">重新绑定后，已有客户端授权失效。</p><Field control={{label:"凭据请求头名",name:"credentialHeader",value:selected.credential_header,required:true,maxLength:64}}/><Field control={{label:"上游凭据",name:"material",type:"password",required:true,autoComplete:"off",maxLength:4096}}/></RuntimeAction></div>
          </div>}
        </section><section className="runtime-retirement" aria-label="退役服务"><p className="caption">退役后不能重新启用，已有客户端授权立即失效。</p><RuntimeAction installation={selected} action="retire" label="永久退役服务" variant="destructive" message="永久退役此服务？不能重新启用，客户端授权立即失效。" details="后续调用被拒绝并清理上游凭据；不撤回已执行的上游操作。"/></section></section>:null}
      {model.section==="tools"&&model.openApiDomains
        ?<FeishuToolSelection installation={selected} domains={model.openApiDomains}/>:null}
    </section>:model.selectedId?<Card className="workspace-section" data-runtime-missing=""><h2>没有这个工具服务</h2><p className="caption">这个工具服务当前不可用。</p><TaskLink className="action-link" href={runtimeAdminHref()}>查看工具服务</TaskLink></Card>:model.installations.length?<p className="empty">选择一个工具服务，管理成员权限与上游凭据。</p>:null}
  </div>;
}
