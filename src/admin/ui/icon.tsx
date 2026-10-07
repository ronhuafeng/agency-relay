import { Home, CreditCard, Users, Terminal, Activity, ChartNoAxesColumn, Network, RefreshCw, ArrowRight, ChevronLeft, ChevronDown, X, Plus, Search, TriangleAlert, Check, KeyRound, Wallet, ScrollText, Pencil, Ban, MoreHorizontal, type LucideIcon } from "lucide-react";
const icons = { overview: Home, credentials: CreditCard, keys: KeyRound, access: Users, setup: Terminal, audit: Activity, usage: ChartNoAxesColumn, surfaces: Network, quotas: Wallet, "control-audit": ScrollText, refresh: RefreshCw, arrow: ArrowRight, back: ChevronLeft, expand: ChevronDown, close: X, plus: Plus, search: Search, attention: TriangleAlert, check: Check, edit: Pencil, configure: Terminal, revoke: Ban, more: MoreHorizontal } satisfies Record<string, LucideIcon>;
export type IconName = keyof typeof icons;
export function Icon({name}: {readonly name: IconName}) {
  const Glyph = icons[name];
  return <Glyph className="ui-icon" aria-hidden="true" focusable="false" strokeWidth={1.75} />;
}
