import {Button} from "../components/button";
import {runtimeMemberHref} from "./runtime";
import {larkToolIdentities,larkTools} from "../../../runtime/connectors/lark-doc/profile";

/** Client metadata is untrusted text; React escaping is the only projection. */
export function RuntimeConsent({client_name,resource,scope,action,email,feishu_installation,feishu_tools,feishu_service_tag}:{readonly client_name:string;readonly resource:string;readonly scope:string;readonly action:string;readonly email:string;readonly feishu_installation?:string;readonly feishu_tools?:string[];readonly feishu_service_tag?:string}) {
  return <section className="gate">
    <h1>允许这个客户端使用服务？</h1>
    <p className="lede">{client_name}</p>
    <p>当前组织账号：{email}</p>
    <p>注册名称由客户端提供，不代表 Agency Relay 已验证其身份。</p>
    <dl><dt>服务地址</dt><dd><code>{resource}</code></dd><dt>权限</dt><dd><code>{scope}</code>{feishu_installation?" · 使用此飞书文档服务":" · 使用此服务的全部工具"}</dd></dl>
    {feishu_installation?<><p>客户端可使用管理员当前启用的飞书工具，包括读取和写入。管理员新增或关闭工具后，客户端刷新即可看到更新。</p><p>Relay 优先使用你的飞书账号。标有「应用身份备用」的工具也可在成员令牌缺少权限时使用应用身份，访问应用获准的数据。</p>
      <p><a href={runtimeMemberHref(feishu_installation)} target="_blank" rel="noreferrer">连接或更新飞书账号授权</a>。</p>
      {feishu_tools?.length?<details><summary>查看当前启用的工具（{feishu_tools.length} 项）</summary><ul>{larkTools.filter(tool=>feishu_tools.includes(tool.name)).map(tool=><li key={tool.name}>
        {tool.label}{tool.highRisk?" · 高风险写入":tool.writes?" · 写入":""} · {larkToolIdentities[tool.identity]}
      </li>)}</ul></details>:<p>管理员尚未启用任何飞书工具。</p>}</>
      :<p>客户端会使用组织共享的上游账号。工具可能读取或修改共享资源；这不是只读权限。撤销授权可以阻止后续调用，但不能撤回已完成的操作。</p>}
    <p>授权最长保留 30 天。退出浏览器不会撤销客户端授权。每次调用仍会检查你的当前权限。</p>
    <form className="member-form" method="post" action={action}>
      {feishu_service_tag?<input type="hidden" name="feishu_service" value={feishu_service_tag}/>:null}
      <Button type="submit" name="decision" value="allow" disabled={feishu_tools?.length===0}>允许</Button>
      <Button type="submit" name="decision" value="deny" variant="outline">拒绝</Button>
    </form>
  </section>;
}

export function RuntimeConsentFailure({status}:{readonly status:number}) {
  return <section className="gate"><h1>本次授权未完成</h1>
    <p className="lede">{status===503?"目前无法确认服务权限。":status===403?"本次授权的身份或权限已变更。":"本次授权已过期或无效。"}</p>
    <p>请回到客户端重新开始授权。不会自动重试、切换上游账号或恢复旧权限。</p>
    <Button asChild variant="outline"><a href="/">返回 Agency Relay</a></Button>
  </section>;
}
