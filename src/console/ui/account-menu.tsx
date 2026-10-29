import { LogOut } from "lucide-react";
import { Avatar, AvatarFallback } from "./components/avatar";
import { Button } from "./components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/dropdown-menu";
import { useEnhanced } from "./use-enhanced";
export interface AccountMenuSwitch { readonly href: string; readonly label: string }
export interface AccountMenuControl { readonly email: string; readonly role: "admin" | "user"; readonly switches?: readonly AccountMenuSwitch[] }
function readSwitches(value: object): readonly AccountMenuSwitch[] | null {
  if (!("switches" in value) || value.switches === undefined) return [];
  if (!Array.isArray(value.switches)) return null;
  const switches: AccountMenuSwitch[] = [];
  for (const item of value.switches) {
    if (!item || typeof item !== "object" || !("href" in item) || typeof item.href !== "string" || !("label" in item) || typeof item.label !== "string") return null;
    switches.push({href: item.href, label: item.label});
  }
  return switches;
}
export function readAccountMenu(value: unknown): AccountMenuControl | null {
  if (!value || typeof value !== "object" || !("email" in value) || typeof value.email !== "string" || !("role" in value) || (value.role !== "admin" && value.role !== "user")) return null;
  const switches = readSwitches(value);
  if (!switches) return null;
  return {email: value.email, role: value.role, switches};
}
export function AccountMenuView({control}: {readonly control: AccountMenuControl}) {
  const enhanced = useEnhanced();
  const identity = <><strong>{control.email}</strong><span className="identity-role">{control.role === "admin" ? "管理员" : "成员"}</span></>;
  const avatar = <Avatar aria-hidden="true"><AvatarFallback>{control.email.slice(0,1).toUpperCase()}</AvatarFallback></Avatar>;
  const contents = <>{avatar}<span className="account-trigger-identity">{identity}</span></>;
  const trigger = <Button variant="ghost" className="account-menu-trigger" aria-label="账号菜单">{contents}</Button>;
  const switches = control.switches ?? [];
  const nativeSwitches = switches.map(item => <a key={item.href} href={item.href}>{item.label}</a>);
  const menuSwitches = switches.map(item => <DropdownMenuItem key={item.href} asChild><a href={item.href}>{item.label}</a></DropdownMenuItem>);
  if (!enhanced) return <><Button variant="ghost" className="account-menu-trigger" aria-label="账号菜单" popoverTarget="native-account-menu">{contents}</Button><div id="native-account-menu" popover="auto" className="native-account-menu"><div className="account-menu-identity">{identity}</div>{nativeSwitches}{switches.length ? <hr/> : null}<a href="/logout" data-sign-out="true"><LogOut className="ui-icon" aria-hidden="true"/>退出登录</a></div></>;
  return <DropdownMenu><DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel className="account-menu-identity">{identity}</DropdownMenuLabel><DropdownMenuSeparator/>{menuSwitches}{switches.length ? <DropdownMenuSeparator/> : null}<DropdownMenuItem asChild><a href="/logout" data-sign-out="true"><LogOut className="ui-icon" aria-hidden="true"/>退出登录</a></DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
}
