import { Badge } from "./components/badge";
import { DashLink } from "./chrome";
import { InventorySearchView } from "./fields";
import type { InventorySearchControl } from "./models";

export interface SetupKeyChoice {
  readonly id: string;
  readonly href: string;
  readonly owner: string;
  readonly prefix: string;
  readonly name?: string | null;
  readonly kind?: "human" | "service";
  readonly clients: string;
  readonly state: string;
  readonly status: string;
}
export interface SetupKeyInventoryControl {
  readonly selectedId: string | null;
  readonly choices: readonly SetupKeyChoice[];
  readonly search: InventorySearchControl;
  readonly previousHref: string | null;
  readonly nextHref: string | null;
  readonly page: number;
}
export function SetupKeyChoices({control,showHeading=true}: {readonly control: SetupKeyInventoryControl; readonly showHeading?: boolean}) {
  const emptyLabel = control.search.value.trim() ? "没有匹配的密钥。" : control.page > 1 ? "这一页没有密钥。" : "还没有密钥。";
  return <>{showHeading ? <div className="key-picker-head"><strong>账号与密钥</strong><Badge>{control.choices.length} 个 · 第 {control.page} 页</Badge></div> : null}
    <InventorySearchView control={control.search}/>
    <ul className="key-picker-choices" aria-label="可配置的密钥">{control.choices.length === 0 ? <li className="empty">{emptyLabel}</li> : control.choices.map(choice => <li key={choice.id} data-setup-key-id={choice.id}>
      <DashLink className="key-picker-choice" href={choice.href} current={choice.id===control.selectedId}>
        <span><strong>{choice.name ? `${choice.owner} · ${choice.name}` : choice.owner}</strong><span>{choice.kind==="service"?<Badge>服务账号</Badge>:null}<code>{choice.prefix}</code><span>{choice.clients}</span></span></span>
        <Badge data-key-state={choice.state}>{choice.status}</Badge>
      </DashLink>
    </li>)}</ul>
    {control.previousHref || control.nextHref ? <nav className="inventory-pages" aria-label="密钥列表分页">{control.previousHref ? <DashLink href={control.previousHref}>上一页</DashLink> : null}{control.nextHref ? <DashLink href={control.nextHref}>下一页</DashLink> : null}</nav> : null}
  </>;
}
