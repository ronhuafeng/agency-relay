/** A confirmed server-state switch. Native submission preserves no-script support.
 * Do not move the thumb before the existing mutation response confirms the change. */
export function StatusSwitch({ enabled, label }: { readonly enabled: boolean; readonly label: string }) {
  const id = useId();
  return <div className="status-switch-control"><Switch id={id} type="submit" checked={enabled} aria-label={`${label}：启用账号`} data-confirm-label={enabled ? "停用账号" : "启用账号"} data-variant={enabled ? "destructive" : "outline"} className="status-switch" /><Label htmlFor={id}>{enabled ? "已启用" : "已停用"}</Label></div>;
}
import { useId } from "react";
import { Label } from "./label";
import { Switch } from "./switch";
