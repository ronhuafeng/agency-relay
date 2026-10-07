import { ArrowRight, LogIn, ShieldAlert, WifiOff } from "lucide-react";
import { Button } from "./components/button";
import { Card } from "./components/card";

export type RecoveryState = "login" | "authority" | "unavailable" | "reopen";
export interface RecoveryPageProps {
  readonly state: RecoveryState;
  readonly description: string;
  readonly href: string;
  readonly actionLabel?: string;
  readonly outcome?: "confirmed" | "rejected" | "unknown";
  readonly brand?: boolean;
}
const states = {
  login: {title: "请重新登录", action: "重新登录", icon: LogIn},
  authority: {title: "页面访问条件已改变", action: "查看当前页面", icon: ShieldAlert},
  unavailable: {title: "暂时无法确认当前账号", action: "查看当前页面", icon: WifiOff},
  reopen: {title: "请重新打开页面", action: "查看当前页面", icon: ShieldAlert}
} as const;
const outcomes = {
  confirmed: "服务器已确认刚才的操作；请只读核对当前状态，不要重复提交。",
  rejected: "刚才的操作未执行。请重新读取当前获准访问的内容。",
  unknown: "刚才的操作结果尚未确认，可能已经执行。请先只读核对，不要重复提交；离开不会撤销服务器操作。"
} as const;

/** Public recovery presentation only. Its owner must establish the reason,
 * remove private state and validate the GET destination before rendering. */
export function RecoveryPage({state, description, href, actionLabel, outcome, brand = true}: RecoveryPageProps) {
  const presentation = states[state];
  return <div className="console-recovery-page" data-console-recovery="" data-recovery-state={state}>
    {brand ? <header className="recovery-brand"><span className="brand-mark" aria-hidden="true">A</span><strong>Agency Relay</strong></header> : null}
    <div className="recovery-stage"><Card className="recovery-card" aria-labelledby="recovery-title">
      <div className="recovery-content"><presentation.icon className="recovery-icon" size={24} strokeWidth={1.75} aria-hidden="true"/>
        <div className="recovery-copy"><h1 id="recovery-title" tabIndex={-1}>{presentation.title}</h1><p>{description}</p></div>
        {outcome ? <p className="recovery-outcome" data-console-outcome={outcome} role="status">{outcomes[outcome]}</p> : null}
        <Button asChild className="recovery-action"><a href={href}>{actionLabel ?? presentation.action}<ArrowRight size={16} aria-hidden="true"/></a></Button>
      </div>
    </Card></div>
  </div>;
}
