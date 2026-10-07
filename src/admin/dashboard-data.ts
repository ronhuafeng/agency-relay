import { readAssignedServiceImpact, type AssignedServiceImpact } from "./service-owner-impact";
import { parseUsageTrendRange, parseUsageQuery } from "./usage-query";
import type { UsageTrendsModel } from "./ui/usage-trends";

import { readServiceOwner, type ServiceOwner } from "../auth/service-delegation";
import { listMemberKeys, type PublicApiKey } from "../auth/api-keys";
import { readControlAudit, type ControlAuditRow } from "./control-audit";
import { readRequestHistory, type RequestHistoryModel } from "./request-history";
import { isOrganizationLoginUser, organizationDomain } from "../auth/principal";
import type { AdminIdentity } from "../auth/authenticate";
import type { CodexAccountSnapshot } from "../codex/account";
import { queryUsageDaily, getUser, listCodexAuths, queryClientVerification, queryRequestAttemptState, queryMediaUsageSummary, queryUsageSummary, type KeyClientVerificationRow, type RequestAttemptStateRow } from "../db";
import type { ApiKeySurfaceCredentialRow } from "../auth/bindings";
import type { CodexAuthRow, MediaUsageSummaryRow, UsageSummaryRow } from "../types";
import { listExecutionPlans, publicExecutionPlanPath } from "../plans/execution-plans";
import { projectCodexIdentity, projectGrokIdentity, type AuthManagementProjection } from "./auth-management";
import { listSubscriptionAccounts, publicSubscriptionAccount } from "../auth/subscription-accounts";
import { dashboardInventoryCounts, dashboardPeoplePage, dashboardKeyPage, dashboardPersonKey, dashboardAccessKeys, dashboardKeyOwners, dashboardKeyBindings, dashboardAccountKeys, type DashboardPage, type DashboardKey, type DashboardAccessKey } from "./inventory";
import { DASHBOARD_PEOPLE_PAGE_SIZE } from "./ui/href";
import { listOrganizationCreditDefaults, listSurfaceCreditStates, type SurfaceCreditState } from "../auth/credits";
import { defaultCredentialMetadataUsable, previewCredentialRetirement, type RetirementPreview } from "../auth/credential-defaults";

const LEDGER_QUERY_LIMIT = 251;
const LEDGER_DISPLAY_LIMIT = 250;
export const DASHBOARD_RANGE_DEFINITIONS = [
  { key: "today", title: "今天", mode: "day", days: 1 },
  { key: "7d", title: "7 天", mode: "range", days: 7 },
  { key: "30d", title: "30 天", mode: "range", days: 30 },
  { key: "all", title: "全部", mode: "all", days: null }
] as const;

/** Product pages first, followed by operational pages. */
export const DASHBOARD_VIEW_DEFINITIONS = [
  { key: "overview", title: "组织概览", group: "workspace" },
  { key: "access", title: "成员与服务", group: "workspace" },
  { key: "setup", title: "客户端配置", group: "workspace" },
  { key: "credentials", title: "上游连接", group: "resources" },
  { key: "quotas", title: "额度政策", group: "resources" },
  { key: "audit", title: "请求记录", group: "observation" },
  { key: "usage", title: "用量报告", group: "observation" },
  { key: "surfaces", title: "服务路由", group: "advanced" },
  { key: "control-audit", title: "管理记录", group: "advanced" }
] as const;

export type DashboardRangeKey = typeof DASHBOARD_RANGE_DEFINITIONS[number]["key"];
export type DashboardViewKey = typeof DASHBOARD_VIEW_DEFINITIONS[number]["key"];

export function dashboardViewTitle(view: DashboardViewKey): string {
  return DASHBOARD_VIEW_DEFINITIONS.find(item => item.key === view)?.title ?? "控制台";
}

export type DashboardMutationFlash =
  | { kind: "key_created"; token: string; key_id: string; key_prefix: string; user_id: string; email?: string | null; scopes: string[] }
  | {
      kind: "key_replacement_created";
      token: string;
      key_id: string;
      key_prefix: string;
      user_id: string;
      email?: string | null;
      scopes: string[];
      previous_key_id: string;
      previous_key_prefix: string;
      old_key_remains_active: boolean;
      return_url?: string;
      previous_key_url?: string;
    }
  | { kind: "key_revoked"; key_id: string; key_prefix: string | null; already_revoked: boolean }
  | { kind: "key_replacement_error"; key_id: string; user_id: string; message: string }
  | { kind: "user_status"; user_id: string; email?: string | null; status: string }
  | { kind: "user_role"; user_id: string; role: "admin" | "user" }
  | { kind: "user_email"; user_id: string; email: string; previous_email: string | null }
  | { kind: "user_lifecycle_error"; user_id: string; action: string; email: string; message: string }
  | { kind: "user_created"; user_id: string; email?: string | null }
  | { kind: "service_owner_changed"; user_id: string }
  | { kind: "service_changed"; user_id: string; action: "create" | "rename" | "classify"; display_name: string }
  | { kind: "service_error"; user_id?: string; action: string; display_name: string; message: string }
  | { kind: "user_create_error"; email: string; message: string }
  | { kind: "credit_default"; defaults: readonly {surface_grant: string; monthly_allowance:number}[] }
  | { kind: "credit_default_error"; message: string }
  | { kind: "credit_policy"; user_id: string; email?: string | null; surface: string; mode: "unlimited" | "limited" | "disabled"; monthly_allowance: number | null; source: "personal" | "organization" | "unconfigured" }
  | { kind: "codex_created"; auth_id: string }
  | { kind: "codex_imported"; auth_id: string }
  | { kind: "codex_refreshed"; auth_id: string }
  | { kind: "codex_refresh_error"; auth_id: string; message: string }
  | { kind: "codex_logged_out"; auth_id: string }
  | { kind: "codex_oauth_started"; auth_id: string; session_id: string; authorize_url: string; redirect_uri: string }
  | { kind: "grok_created"; account_id: string }
  | { kind: "grok_imported"; account_id: string }
  | { kind: "grok_refreshed"; account_id: string }
  | { kind: "grok_logged_out"; account_id: string }
  | { kind: "grok_oauth_started"; account_id: string; session_id: string; authorize_url: string; redirect_uri: string }
  | { kind: "credential_default"; surface_grant: string; account_id: string }
  | { kind: "credential_migrated"; provider: "codex" | "grok"; account_id: string; bindings: number; defaults: number }
  | { kind: "credential_disconnected"; provider: "codex" | "grok"; account_id: string; token_cleanup: "cleared" | "failed" }
  | { kind: "credential_cleanup"; provider: "codex" | "grok"; account_id: string; token_cleanup: "cleared" | "failed" }
  | { kind: "credential_task_error"; provider?: "codex" | "grok"; account_id?: string; surface_grant?: string; message: string }
  | { kind: "credential_binding"; key_id: string; surface_grant: string };

export interface AdminDashboardInput {
  env: Env;
  url: URL;
  identity: AdminIdentity;
  now: Date;
  requestId: string;
  loadCodexAccount: (authId: string) => Promise<CodexAccountSnapshot>;
  mutationFlash?: DashboardMutationFlash | null;
}

export interface DashboardRange {
  key: DashboardRangeKey;
  title: string;
  label: string;
  emptyLabel: string;
  mode: "all" | "day" | "range";
  day: string | null;
  from: string | null;
  to: string | null;
  rawUsageUrl: string;
}

export interface AdminDashboardPageModelBase {
  appEnabled: boolean;
  canonicalUrl: string;
  documentTitle: string;
  view: DashboardViewKey;
  operatorLabel: string;
  operatorId: string | null;
  range: DashboardRange;
  nowMs: number;
  dataAsOf: string;
  mutationFlash?: DashboardMutationFlash | null;
}

export interface AdminDashboardOverviewModel extends AdminDashboardPageModelBase {
  view: "overview";
  userCount: number;
  keyCount: number;
  attempts: RequestAttemptStateRow[];
  accounts: Array<{ key: string; label: string; client: "Codex" | "Grok"; projection: AuthManagementProjection }>;
  trends: UsageTrendsModel | null;
}

export interface AdminDashboardUsageModel extends AdminDashboardPageModelBase {
  view: "usage";
  trends: UsageTrendsModel;
  rows: UsageSummaryRow[];
  mediaRows: MediaUsageSummaryRow[];
  rowsTruncated: boolean;
  mediaRowsTruncated: boolean;
}

export interface AdminDashboardSurfacesModel extends AdminDashboardPageModelBase {
  view: "surfaces";
  routes: SurfaceRow[];
}

export interface SurfaceRow {
  id: string;
  hostname: string;
  method: string;
  path: string;
  grant: string;
  slot: string;
  last_success_at: string | null;
  last_failure_at: string | null;
}

export interface AdminDashboardCredentialsModel extends AdminDashboardPageModelBase {
  view: "credentials";
  accounts: Array<{ key: string; id: string; provider: "codex" | "grok"; label: string; defaultEligible: boolean; projection: AuthManagementProjection }>;
  selectedAccountKey: string | null;
  snapshot: CodexAccountSnapshot | null;
  linkedKeys: Awaited<ReturnType<typeof dashboardAccountKeys>> | null;
  issuanceDefaults: Array<{ surface_grant: string; account_id: string | null }> | null;
  retirement: RetirementPreview | null;
}

export interface AdminDashboardAccessModel extends AdminDashboardPageModelBase {
  view: "access";
  selectedPersonId?: string | null;
  addingPerson?: boolean;
  addingService?: boolean;
  givingAccess?: boolean;
  assignedServiceImpact?: AssignedServiceImpact;
  serviceOwner?: ServiceOwner | null;
  serviceOwnerCandidates?: Array<{id:string;canonical_email:string}> | null;
  serviceOwnerKeys?: PublicApiKey[] | null;
  selectedUser: Awaited<ReturnType<typeof getUser>>;
  selectedKeyId: string | null;
  selectedKey: DashboardKey | null;
  peoplePage: DashboardPage<AdminDashboardAccessModel["users"][number]>;
  keyPage: DashboardPage<DashboardKey> | null;
  accessKeys: DashboardAccessKey[];
  users: Array<{ id: string; email: string | null; role?: "admin" | "user"; login_capable?: 0 | 1; account_kind?: "human" | "service" | "legacy_unresolved"; display_name?: string | null; status: string; created_at: string }>;
  keys: DashboardKey[];
  creditStates: SurfaceCreditState[] | null;
  codexAuths: CodexAuthRow[] | null;
  subscriptionAccounts: ReturnType<typeof publicSubscriptionAccount>[] | null;
  credentialBindings: ApiKeySurfaceCredentialRow[];
}

export interface AdminDashboardSetupModel extends AdminDashboardPageModelBase {
  view: "setup";
  selectedPersonId: string | null;
  selectedKeyId: string | null;
  selectedKey: DashboardKey | null;
  users: AdminDashboardAccessModel["users"];
  keys: AdminDashboardAccessModel["keys"];
  keyPage: DashboardPage<DashboardKey>;
  verifications: KeyClientVerificationRow[];
}

export interface AdminDashboardAuditModel extends AdminDashboardPageModelBase {
  view: "audit";
  history: RequestHistoryModel;
}

export interface AdminDashboardQuotasModel extends AdminDashboardPageModelBase {
  view: "quotas";
  defaults: Array<{ surface_grant: string; monthly_allowance: number; shared_provider_authority?: string }>;
}

export interface AdminDashboardControlAuditModel extends AdminDashboardPageModelBase {
  view: "control-audit";
  rows: ControlAuditRow[];
  truncated: boolean;
}

export type AdminDashboardPageModel =
  | AdminDashboardOverviewModel
  | AdminDashboardUsageModel
  | AdminDashboardSurfacesModel
  | AdminDashboardCredentialsModel
  | AdminDashboardAccessModel
  | AdminDashboardSetupModel
  | AdminDashboardAuditModel
  | AdminDashboardQuotasModel
  | AdminDashboardControlAuditModel;


export async function loadDashboard(input: AdminDashboardInput, base: AdminDashboardPageModelBase, selection: {person: string | null; key: string | null; account: string | null; task: string | null; inventory: URLSearchParams}): Promise<AdminDashboardPageModel> {
  const { view, range } = base;
  const {person: requestedPerson, key: requestedKey, account: requestedAccount, task, inventory: inventoryQuery} = selection;
  let model: AdminDashboardPageModel;
  switch (view) {
    case "overview": {
    const trendRange = parseUsageTrendRange(input.url, input.now);
    const [attempts, counts, codexAuths, daily] = await Promise.all([
      queryRequestAttemptState(input.env),
      dashboardInventoryCounts(input.env),
      listCodexAuths(input.env),
      queryUsageDaily(input.env, { mode: "range", from: trendRange.from, to: trendRange.to, limit: LEDGER_QUERY_LIMIT }).catch(() => null)
    ]);
    const accounts = await listSubscriptionAccounts(input.env);
    model = {
      ...base,
      view,
      ...counts,
      attempts,
      trends: daily ? {range: trendRange, daily, scopeLabel: "组织用量", navigationUrl: base.canonicalUrl} : null,
      accounts: [
      ...codexAuths.map((auth) => ({
        key: `codex:${auth.id}`,
        label: auth.label,
        client: "Codex" as const,
        projection: projectCodexIdentity({ auth, nowMs: base.nowMs })
      })),
      ...accounts.filter((account) => account.capability_source === "grok").map((account) => ({
        key: `grok:${account.id}`,
        label: account.label,
        client: "Grok" as const,
        projection: projectGrokIdentity({ account, nowMs: base.nowMs })
      }))
      ]
    };
    break;
    }
    case "usage": {
    const parsed = parseUsageQuery(new URL(range.rawUsageUrl, input.url));
    const usageQuery = { mode: parsed.mode, ...parsed.filters, limit: LEDGER_QUERY_LIMIT };
    const [usage, mediaUsage, daily] = await Promise.all([
      queryUsageSummary(input.env, usageQuery),
      queryMediaUsageSummary(input.env, usageQuery),
      queryUsageDaily(input.env, usageQuery)
    ]);
    model = {
      ...base,
      view,
      trends: {range: parseUsageTrendRange(input.url, input.now), daily, scopeLabel: requestedPerson ? "所选用户" : "组织用量", navigationUrl: base.canonicalUrl,
        filterLabel: [requestedPerson ? `用户：${requestedPerson}` : "", usageQuery.route_profile_id ? `执行计划：${usageQuery.route_profile_id}` : "", usageQuery.response_model ? `模型：${usageQuery.response_model}（仅 Responses）` : ""].filter(Boolean).join(" · ")},
      rows: usage.rows.slice(0, LEDGER_DISPLAY_LIMIT),
      mediaRows: mediaUsage.rows.slice(0, LEDGER_DISPLAY_LIMIT),
      rowsTruncated: usage.rows.length > LEDGER_DISPLAY_LIMIT,
      mediaRowsTruncated: mediaUsage.rows.length > LEDGER_DISPLAY_LIMIT
    };
    break;
    }
    case "surfaces": {
    const attempts = await queryRequestAttemptState(input.env);
    const routes = listExecutionPlans().map((plan) => {
      const attempt = attempts.find((row) => row.route_profile_id === plan.id);
      return {
      id: plan.id,
      hostname: plan.hostname,
      method: plan.method,
      path: publicExecutionPlanPath(plan),
      grant: plan.surfaceGrant,
      slot: plan.credentialSlot,
      last_success_at: attempt?.last_success_at ?? null,
      last_failure_at: attempt?.last_failure_at ?? null
      };
    });
    model = { ...base, view, routes };
    break;
    }
    case "credentials": {
    const [subscriptions, auths] = await Promise.all([listSubscriptionAccounts(input.env), listCodexAuths(input.env)]);
    const codexPending = input.mutationFlash?.kind === "codex_oauth_started" ? input.mutationFlash : null;
    const grokPending = input.mutationFlash?.kind === "grok_oauth_started" ? input.mutationFlash : null;
    const accounts: AdminDashboardCredentialsModel["accounts"] = [
      ...auths.map(auth => ({ key: `codex:${auth.id}`, id: auth.id, provider: "codex" as const, label: auth.label,
      defaultEligible: auth.kind === "shared" && auth.environment === "production" && defaultCredentialMetadataUsable(auth.status),
      projection: projectCodexIdentity({ auth, nowMs: base.nowMs, oauthPending: codexPending?.auth_id === auth.id ? codexPending : null }) })),
      ...subscriptions.filter(account => account.capability_source === "grok").map(account => ({ key: `grok:${account.id}`, id: account.id, provider: "grok" as const, label: account.label,
      defaultEligible: account.environment === "production" && defaultCredentialMetadataUsable(account.status),
      projection: projectGrokIdentity({ account, nowMs: base.nowMs, oauthPending: grokPending?.account_id === account.id ? grokPending : null }) }))
    ];
    const selected = accounts.find(account => account.key === requestedAccount);
    const linkedKeys = selected ? await dashboardAccountKeys(input.env, selected.provider, selected.id, Number(inventoryQuery.get("page") ?? 1)) : null;
    const issuanceDefaults = await readIssuanceDefaults(input.env);
    const retirement = selected ? await readRetirement(input.env, selected.provider, selected.id) : null;
    model = {
      ...base,
      view,
      accounts,
      selectedAccountKey: requestedAccount,
      linkedKeys,
      snapshot: selected?.provider === "codex" ? await input.loadCodexAccount(selected.id) : null,
      issuanceDefaults,
      retirement
    };
    break;
    }
    case "access": {
    const [peoplePage, selectedUser] = await Promise.all([
      dashboardPeoplePage(input.env, inventoryQuery.get("q") ?? "", Number(inventoryQuery.get("page") ?? 1), inventoryQuery.get("kind") ?? "human", Number(inventoryQuery.get("page_size") ?? DASHBOARD_PEOPLE_PAGE_SIZE)),
      requestedPerson === null ? null : getUser(input.env, requestedPerson)
    ]);
    const userIds = [...new Set([...peoplePage.rows.map(user => user.id), ...(selectedUser ? [selectedUser.id] : [])])];
    const personOverview = selectedUser;
    const [accessKeys, keyPage, creditStates, selectedKey] = await Promise.all([
      dashboardAccessKeys(input.env, userIds),
      personOverview ? dashboardKeyPage(input.env, { person: selectedUser.id, search: inventoryQuery.get("key_q") ?? "", page: Number(inventoryQuery.get("key_page") ?? 1) }).catch(() => null) : { rows: [], page: 1, hasNext: false },
      personOverview ? listSurfaceCreditStates(input.env, input.now, selectedUser.id).catch(() => null) : [],
      selectedUser && requestedKey !== null ? dashboardPersonKey(input.env, selectedUser.id, requestedKey) : null
    ]);
    const credentialBindings = selectedKey ? await dashboardKeyBindings(input.env, [selectedKey.id]) : [];
    const needsAccounts = Boolean(selectedKey || selectedUser && task === "give-access");
    const [codexAuths, subscriptionAccounts] = needsAccounts ? await Promise.all([
      listCodexAuths(input.env).catch(() => null), listSubscriptionAccounts(input.env).catch(() => null)
    ]) : [[], []];
    const serviceIdentity = selectedUser?.account_kind === "service" ? await Promise.all([
      readServiceOwner(input.env, selectedUser.id).catch(() => null),
      (async () => (await input.env.DB.prepare(`SELECT id, canonical_email FROM users WHERE account_kind = 'human' AND status = 'active' AND login_capable = 1 AND substr(canonical_email, instr(canonical_email, '@') + 1) = ? ORDER BY canonical_email`).bind(organizationDomain(input.env) ?? "").all<{id:string;canonical_email:string}>()).results)().catch(() => null),
      listMemberKeys(input.env, selectedUser.id, input.now).catch(() => null)
    ]) : null;
    model = {
      ...base,
      view,
      users: peoplePage.rows.map(user => ({ ...user, login_capable: isOrganizationLoginUser(input.env, user) ? 1 : 0 })),
      ...(serviceIdentity ? {
        serviceOwner: serviceIdentity[0], serviceOwnerCandidates: serviceIdentity[1], serviceOwnerKeys: serviceIdentity[2]
      } : {}),
      ...(personOverview && selectedUser.account_kind === "human" ? {assignedServiceImpact: await readAssignedServiceImpact(input.env, selectedUser.id)} : {}),
      selectedUser: selectedUser ? { ...selectedUser, login_capable: isOrganizationLoginUser(input.env, selectedUser) ? 1 : 0 } : null,
      selectedKeyId: requestedKey,
      selectedKey,
      peoplePage,
      keyPage,
      accessKeys,
      selectedPersonId: requestedPerson,
      addingPerson: input.url.searchParams.get("task") === "add-person",
      addingService: input.url.searchParams.get("task") === "add-service",
      givingAccess: input.url.searchParams.get("task") === "give-access",
      keys: keyPage?.rows ?? [],
      creditStates,
      codexAuths,
      subscriptionAccounts: subscriptionAccounts?.map(publicSubscriptionAccount) ?? null,
      credentialBindings
    };
    break;
    }
    case "setup": {
    const [keyPage, selectedKey] = await Promise.all([
      dashboardKeyPage(input.env, { search: inventoryQuery.get("q") ?? "", page: Number(inventoryQuery.get("page") ?? 1), activeOnly: true }),
      requestedPerson !== null && requestedKey !== null ? dashboardPersonKey(input.env, requestedPerson, requestedKey) : null
    ]);
    const [users, verifications] = await Promise.all([
      dashboardKeyOwners(input.env, [...new Set([...keyPage.rows.map(key => key.user_id), ...(selectedKey ? [selectedKey.user_id] : [])])]),
      selectedKey ? queryClientVerification(input.env, [selectedKey.id]) : []
    ]);
    model = { ...base, view, users, keys: keyPage.rows, keyPage, verifications, selectedKey, selectedKeyId: requestedKey, selectedPersonId: requestedPerson };
    break;
    }
    case "audit": {
    const detail = input.url.searchParams.has("record");
    const history = await readRequestHistory(input.env, input.url);
    model = { ...base, view, history, ...(detail ? { documentTitle: "请求记录详情 · Agency Relay 控制台" } : {}) };
    break;
    }
    case "quotas": {
    const defaults = await listOrganizationCreditDefaults(input.env);
    model = { ...base, view, defaults, documentTitle: "额度政策 · Agency Relay 控制台" };
    break;
    }
    case "control-audit": {
    model = { ...base, view, ...await readControlAudit(input.env, base.canonicalUrl) };
    break;
    }
  }
  return model;
}

async function readIssuanceDefaults(env: Env): Promise<AdminDashboardCredentialsModel["issuanceDefaults"]> {
  try {
    const result = await env.DB.prepare(
      `SELECT surface_grant, codex_auth_id, subscription_account_id
       FROM organization_surface_credential_defaults`
    ).all<{ surface_grant: string; codex_auth_id: string | null; subscription_account_id: string | null }>();
    return (result.results ?? []).map((row) => ({
      surface_grant: row.surface_grant,
      account_id: row.codex_auth_id ?? row.subscription_account_id
    }));
  } catch {
    return null;
  }
}

async function readRetirement(env: Env, provider: "codex" | "grok", accountId: string): Promise<AdminDashboardCredentialsModel["retirement"]> {
  try {
    return await previewCredentialRetirement(env, provider, accountId);
  } catch {
    return null;
  }
}
