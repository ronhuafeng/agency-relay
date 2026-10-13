import {Button} from "../components/button";

/** Client metadata is untrusted text; React escaping is the only projection. */
export function RuntimeConsent({client_name,resource,scope,action,email}:{readonly client_name:string;readonly resource:string;readonly scope:string;readonly action:string;readonly email:string}) {
  return <section className="gate">
    <h1>允许这个客户端使用服务？</h1>
    <p className="lede">{client_name}</p>
    <p>当前组织账号：{email}</p>
    <p>注册名称由客户端提供，不代表 Agency Relay 已验证其身份。</p>
    <dl><dt>服务地址</dt><dd><code>{resource}</code></dd><dt>权限</dt><dd><code>{scope}</code> · 使用此服务的全部工具</dd></dl>
    <p>客户端会使用组织共享的上游账号。工具可能读取或修改共享资源；这不是只读权限。撤销授权可以阻止后续调用，但不能撤回已完成的操作。</p>
    <p>授权最长保留 30 天。退出浏览器不会撤销客户端授权。每次调用仍会检查你的当前权限。</p>
    <form method="post" action={action}>
      <Button type="submit" name="decision" value="allow">允许（Allow）</Button>
      <Button type="submit" name="decision" value="deny" variant="outline">拒绝（Deny）</Button>
    </form>
  </section>;
}

export function RuntimeConsentFailure({status}:{readonly status:number}) {
  return <section className="gate"><h1>本次授权未完成</h1>
    <p className="lede">{status===503?"目前无法确认服务权限。":status===403?"本次授权的身份或权限已变更。":"本次授权已过期或无效。"}</p>
    <p>请回到客户端重新开始授权。不会自动重试、切换账号或恢复旧权限。</p>
    <Button asChild variant="outline"><a href="/">返回 Agency Relay</a></Button>
  </section>;
}
