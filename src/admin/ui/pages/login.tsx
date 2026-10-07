import { Button } from "../components/button";
export function LoginEntry({message, action = "/login"}: {readonly message: string | null; readonly action?: string}) {
  return <section className="gate"><h1>登录</h1><p className="lede">使用组织的飞书账号登录。</p>{message ? <p className="alert" role="alert">{message}</p> : null}<form method="post" action={action}><Button type="submit">使用飞书继续</Button></form></section>;
}
export function LogoutEntry() {
  return <section className="gate"><h1>退出</h1><p className="lede">这只结束浏览器会话，不会撤销密钥。</p><form method="post" action="/logout"><Button type="submit" variant="outline">退出</Button></form></section>;
}
