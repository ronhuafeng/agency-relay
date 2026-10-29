import { Button } from "./components/button";
export function ReadError({title, message, retryUrl, retryLabel, requestId}: {readonly title: string; readonly message: string; readonly retryUrl: string; readonly retryLabel: string; readonly requestId: string}) {
  return <section className="gate"><h1>{title}</h1><p className="lede">{message}</p><Button asChild><a href={retryUrl}>{retryLabel}</a></Button><p className="note">请求编号：<code>{requestId}</code></p></section>;
}
