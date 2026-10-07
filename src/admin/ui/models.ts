import type { SurfaceCapabilityState, SurfaceCapabilityView } from "../../plans/capabilities";

export interface FieldControl {
  readonly label: string;
  readonly name: string;
  readonly type?: "text" | "email" | "url" | "password" | "datetime-local" | "number";
  readonly value?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly autoComplete?: "off";
  readonly maxLength?: number;
  readonly inputMode?: "numeric";
  readonly pattern?: string;
  readonly min?: string;
  readonly max?: string;
  readonly step?: string;
  readonly autoFocus?: boolean;
  readonly invalid?: boolean;
  readonly describedBy?: string;
}


export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
}

export interface SelectControl {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly required: boolean;
  readonly options: readonly SelectOption[];
  readonly value: string;
}

export interface CheckControl {
  readonly name: string;
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly checked: boolean;
}

export type CreditPolicyMode = "limited" | "unlimited" | "disabled";

export interface CreditPolicyControl {
  readonly id: string;
  readonly action: string;
  readonly clientLabel: string;
  readonly personId: string;
  readonly personLabel: string;
  readonly mode: CreditPolicyMode;
  readonly monthlyAllowance: string;
}

export interface AddAccountControl {
  readonly range: string;
  readonly query: string;
  readonly page: string;
}

export interface AccessChoiceControl {
  readonly id: "codex" | "grok" | "xai";
  readonly accessLevel: "everyday" | "selected";
  readonly label: string;
  readonly badge: string | null;
  readonly description: string;
}

export interface SearchField {
  readonly name: string;
  readonly value: string;
}

export interface InventorySearchControl {
  readonly id: string;
  readonly action: string;
  readonly anchor: string;
  readonly label: string;
  readonly field: "q" | "key_q";
  readonly value: string;
  readonly hidden: readonly SearchField[];
  readonly clearHref: string | null;
}

export interface CopySecretControl {
  readonly token: string;
}

export interface DisclosureControl {
  readonly id: string;
  readonly title: string;
  readonly token: string;
}

export interface CapabilityComparisonModel {
  readonly view: {
    readonly surfaces: readonly Pick<SurfaceCapabilityView["surfaces"][number], "id" | "label" | "accessLevel" | "badge" | "authorityLabel" | "authorityNote">[];
    readonly groups: readonly { readonly id: string; readonly label: string; readonly rows: readonly {
      readonly id: string; readonly label: string; readonly description: string;
      readonly cells: Readonly<Record<"codex" | "grok" | "xai", {readonly state: SurfaceCapabilityState; readonly label: string; readonly detail?: string}>>;
    }[] }[];
  };
  readonly routesHref: string;
}

export interface MemberKeyFormModel {
  readonly action?: string;
  readonly returnHref?: string;
  readonly submissionId?: string;
  readonly surfaces: readonly CheckControl[];
  readonly expiry: SelectControl;
  readonly lead: string | null;
  readonly canCreate: boolean;
}

export interface UsageFact {
  readonly label: string;
  readonly value: string;
  readonly tone?: "bad";
}
export interface UsageRecord {
  readonly id: string;
  readonly authority: string;
  readonly service: string;
  readonly plan: string;
  readonly owner: string;
  readonly title: string;
  readonly metrics: readonly UsageFact[];
  readonly details: readonly UsageFact[];
  readonly note: string | null;
}
export interface UsageReportControl {
  readonly records: readonly UsageRecord[];
  readonly emptyLabel: string;
  readonly exportUrl: string;
  readonly truncated: boolean;
  readonly filterPlaceholder: string;
  readonly limitNote: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUsageFacts(value: unknown): UsageFact[] | null {
  if (!Array.isArray(value)) return null;
  const facts: UsageFact[] = [];
  for (const fact of value) {
    if (!isRecord(fact) || typeof fact.label !== "string" || typeof fact.value !== "string") return null;
    facts.push({label: fact.label, value: fact.value});
  }
  return facts;
}
export function readUsageReport(value: unknown): UsageReportControl | null {
  if (!isRecord(value) || !Array.isArray(value.records) || typeof value.emptyLabel !== "string" || typeof value.exportUrl !== "string" || typeof value.truncated !== "boolean" || typeof value.filterPlaceholder !== "string" || typeof value.limitNote !== "string") return null;
  if (!value.exportUrl.startsWith("/admin/usage?") && !/^\/me\/(?:usage|service-accounts\/[^/?#]+\/usage)(?:\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}(?:&q=[^&#]*)?)?$/.test(value.exportUrl)) return null;
  const records: UsageRecord[] = [];
  for (const record of value.records) {
    if (!isRecord(record) || typeof record.id !== "string" || typeof record.authority !== "string" || typeof record.service !== "string" || typeof record.plan !== "string" || typeof record.owner !== "string" || typeof record.title !== "string" || record.note !== null && typeof record.note !== "string") return null;
    const metrics = readUsageFacts(record.metrics); const details = readUsageFacts(record.details);
    if (!metrics || !details) return null;
    records.push({id: record.id, authority: record.authority, service: record.service, plan: record.plan, owner: record.owner, title: record.title, metrics, details, note: record.note});
  }
  return {records, emptyLabel: value.emptyLabel, exportUrl: value.exportUrl, truncated: value.truncated, filterPlaceholder: value.filterPlaceholder, limitNote: value.limitNote};
}

function readOption(value: unknown): SelectOption | null {
  if (!isRecord(value)) return null;
  if (typeof value.value !== "string" || typeof value.label !== "string" || typeof value.disabled !== "boolean") return null;
  return { value: value.value, label: value.label, disabled: value.disabled };
}

export function readSelectControl(value: unknown): SelectControl | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.label !== "string") return null;
  if (typeof value.required !== "boolean" || typeof value.value !== "string" || !Array.isArray(value.options)) return null;
  const options: SelectOption[] = [];
  for (const option of value.options) {
    const parsed = readOption(option);
    if (!parsed) return null;
    options.push(parsed);
  }
  return { id: value.id, name: value.name, label: value.label, required: value.required, options, value: value.value };
}

export function isCreditPolicyMode(value: unknown): value is CreditPolicyMode {
  return value === "limited" || value === "unlimited" || value === "disabled";
}

export function readCreditPolicy(value: unknown): CreditPolicyControl | null {
  if (!isRecord(value) || !isCreditPolicyMode(value.mode)) return null;
  if (typeof value.id !== "string" || typeof value.action !== "string" || !value.action.startsWith("/admin/ui/users/")) return null;
  if (typeof value.clientLabel !== "string" || typeof value.personId !== "string" || typeof value.monthlyAllowance !== "string") return null;
  if (value.personLabel !== undefined && typeof value.personLabel !== "string") return null;
  if (value.monthlyAllowance !== "" && !/^\d+$/.test(value.monthlyAllowance)) return null;
  return {
    id: value.id,
    action: value.action,
    clientLabel: value.clientLabel,
    personId: value.personId,
    personLabel: typeof value.personLabel === "string" && value.personLabel.trim() ? value.personLabel : value.personId,
    mode: value.mode,
    monthlyAllowance: value.monthlyAllowance
  };
}

export function readAddAccount(value: unknown): AddAccountControl | null {
  if (!isRecord(value)) return null;
  if (typeof value.range !== "string" || typeof value.query !== "string" || typeof value.page !== "string") return null;
  return { range: value.range, query: value.query, page: value.page };
}

export function readAccessChoice(value: unknown): AccessChoiceControl | null {
  if (!isRecord(value) || !isAccessId(value.id)) return null;
  if (value.accessLevel !== "everyday" && value.accessLevel !== "selected") return null;
  if (typeof value.label !== "string" || typeof value.description !== "string") return null;
  if (value.badge !== null && typeof value.badge !== "string") return null;
  return {
    id: value.id,
    accessLevel: value.accessLevel,
    label: value.label,
    badge: value.badge,
    description: value.description
  };
}

export function readCheckControl(value: unknown): CheckControl | null {
  if (!isRecord(value)) return null;
  if (typeof value.name !== "string" || typeof value.value !== "string" || typeof value.label !== "string") return null;
  if (typeof value.disabled !== "boolean" || typeof value.checked !== "boolean") return null;
  return { name: value.name, value: value.value, label: value.label, disabled: value.disabled, checked: value.checked };
}

function isAccessId(value: unknown): value is "codex" | "grok" | "xai" {
  return value === "codex" || value === "grok" || value === "xai";
}

function isCapabilityState(value: unknown): value is SurfaceCapabilityState {
  switch (value) {
    case "included":
    case "owner_bound":
    case "team_access":
    case "in_client":
    case "api_building_blocks":
    case "list_only":
    case "upgrade_required":
    case "not_available":
      return true;
    default:
      return false;
  }
}

function readCell(value: unknown): { state: SurfaceCapabilityState; label: string; detail?: string } | null {
  if (!isRecord(value) || !isCapabilityState(value.state) || typeof value.label !== "string") return null;
  if (value.detail !== undefined && typeof value.detail !== "string") return null;
  return { state: value.state, label: value.label, ...(typeof value.detail === "string" ? { detail: value.detail } : {}) };
}

export function readCapabilityComparison(value: unknown): CapabilityComparisonModel | null {
  if (!isRecord(value) || typeof value.routesHref !== "string" || !isRecord(value.view)) return null;
  const view = value.view;
  if (!Array.isArray(view.surfaces) || !Array.isArray(view.groups)) return null;
  const surfaces: CapabilityComparisonModel["view"]["surfaces"][number][] = [];
  for (const surface of view.surfaces) {
    if (!isRecord(surface) || !isAccessId(surface.id) || typeof surface.label !== "string") return null;
    if (surface.accessLevel !== "everyday" && surface.accessLevel !== "selected") return null;
    if (typeof surface.badge !== "string") return null;
    if (typeof surface.authorityLabel !== "string" || typeof surface.authorityNote !== "string") return null;
    surfaces.push({
      id: surface.id,
      label: surface.label,
      accessLevel: surface.accessLevel,
      badge: surface.badge,
      authorityLabel: surface.authorityLabel,
      authorityNote: surface.authorityNote
    });
  }
  const groups: CapabilityComparisonModel["view"]["groups"][number][] = [];
  for (const group of view.groups) {
    if (!isRecord(group) || typeof group.id !== "string" || typeof group.label !== "string" || !Array.isArray(group.rows)) return null;
    const rows: CapabilityComparisonModel["view"]["groups"][number]["rows"][number][] = [];
    for (const row of group.rows) {
      if (!isRecord(row) || typeof row.id !== "string" || typeof row.label !== "string" || typeof row.description !== "string" || !isRecord(row.cells)) return null;
      const codex = readCell(row.cells.codex);
      const grok = readCell(row.cells.grok);
      const xai = readCell(row.cells.xai);
      if (!codex || !grok || !xai) return null;
      rows.push({ id: row.id, label: row.label, description: row.description, cells: { codex, grok, xai } });
    }
    groups.push({ id: group.id, label: group.label, rows });
  }
  return { routesHref: value.routesHref, view: { surfaces, groups } };
}

export function readCopySecret(value: unknown): CopySecretControl | null {
  if (!isRecord(value) || typeof value.token !== "string" || value.token.length === 0) return null;
  return { token: value.token };
}

export function readDisclosure(value: unknown): DisclosureControl | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.token !== "string") return null;
  return { id: value.id, title: value.title, token: value.token };
}

export function readMemberKeyForm(value: unknown): MemberKeyFormModel | null {
  if (!isRecord(value) || !Array.isArray(value.surfaces)) return null;
  if (value.lead !== null && typeof value.lead !== "string") return null;
  if (typeof value.canCreate !== "boolean") return null;
  const expiry = readSelectControl(value.expiry);
  if (!expiry) return null;
  const surfaces: CheckControl[] = [];
  for (const surface of value.surfaces) {
    const parsed = readCheckControl(surface);
    if (!parsed) return null;
    surfaces.push(parsed);
  }
  if (value.action !== undefined && (typeof value.action !== "string" || !/^\/me(?:\/service-accounts\/[^/]+)?\/ui\/keys$/.test(value.action))) return null;
  if (value.returnHref !== undefined && typeof value.returnHref !== "string") return null;
  return { action: value.action as string | undefined, returnHref: value.returnHref as string | undefined, surfaces, expiry, lead: value.lead, canCreate: value.canCreate, ...(typeof value.submissionId === "string" ? {submissionId: value.submissionId} : {}) };
}
