import { ChevronDown, LogOut } from "lucide-react";
import { Avatar, AvatarFallback } from "./components/avatar";
import { Button } from "./components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/dropdown-menu";
import { useEnhanced } from "./use-enhanced";
export interface AccountMenuControl { readonly email: string; readonly role: "admin" | "user" }
export function readAccountMenu(value: unknown): AccountMenuControl | null {
  if (!value || typeof value !== "object" || !("email" in value) || typeof value.email !== "string" || !("role" in value) || (value.role !== "admin" && value.role !== "user")) return null;
  return {email:value.email,role:value.role};
}
export function AccountMenuView({control}: {readonly control: AccountMenuControl}) {
  const enhanced = useEnhanced();
  const identity = <><strong>{control.email}</strong><span className="identity-role">{control.role === "admin" ? "管理员" : "成员"}</span></>;
  const avatar = <Avatar aria-hidden="true"><AvatarFallback>{control.email.slice(0,1).toUpperCase()}</AvatarFallback></Avatar>;
  const contents = <>{avatar}<span className="account-trigger-identity">{identity}</span><ChevronDown className="ui-icon" aria-hidden="true"/></>;
  const trigger = <Button variant="ghost" className="account-menu-trigger" aria-label="账号菜单">{contents}</Button>;
  if (!enhanced) return <><Button variant="ghost" className="account-menu-trigger" aria-label="账号菜单" popoverTarget="native-account-menu">{contents}</Button><div id="native-account-menu" popover="auto" className="native-account-menu"><div className="account-menu-identity">{identity}</div><a href="/logout" data-sign-out="true"><LogOut className="ui-icon" aria-hidden="true"/>退出登录</a></div></>;
  return <DropdownMenu><DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel className="account-menu-identity">{identity}</DropdownMenuLabel><DropdownMenuSeparator/><DropdownMenuItem asChild><a href="/logout" data-sign-out="true"><LogOut className="ui-icon" aria-hidden="true"/>退出登录</a></DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
}
