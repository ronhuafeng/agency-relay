import type { CodexAccountSnapshot } from "../../../codex/account";
import { AccountDossier } from "../account-dossier";
import { parseApiKeyScopes } from "../../../auth/authenticate";
import type { AuthManagementAction, AuthManagementProjection } from "../../auth-management";
import { actionButtonLabel, operatorHintForState, statusToneForState } from "../../auth-management";
import { productAccessLabels } from "../../client-setup";
import { formatNumber, formatOperatorInstant, personLabel, presentText } from "../../format";
import { keyStateLabel } from "../../key-label";
import { AddAccountIsland } from "../islands";
import { Button } from "../components/button";
import { ConfirmationFallback, Field, InventorySearchView } from "../fields";
import { DashLink } from "../chrome";
import { accountDashboardUrl, inventoryUrl } from "../href";
import { Icon } from "../icon";
import { InventoryPages, inventorySearchControl } from "../inventory";
import { Badge } from "../components/badge";
import { Card } from "../components/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/table";
import { InfoPopover } from "../components/info-popover";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import { Label } from "../components/label";
import { ObjectWorkspace, TaskClose } from "../task-workspace";
import type { RetirementPreview } from "../../../auth/credential-defaults";

interface AccountRecord {
  readonly key: string;
  readonly id: string;
  readonly provider: "codex" | "grok";
  readonly label: string;
  readonly defaultEligible: boolean;
  readonly projection: AuthManagementProjection;
}

interface LinkedKey {
  readonly id: string;
  readonly user_id: string;
  readonly user_email: string | null;
  readonly key_prefix: string;
  readonly status: string;
  readonly scopes: string;
  readonly expires_at: string | null;
  readonly user_status: string | null;
  readonly bound_grants: readonly string[];
}

export interface AccountsPageModel {
  readonly snapshot: CodexAccountSnapshot | null;
  readonly canonicalUrl: string;
  readonly range: { readonly key: string };
  readonly nowMs: number;
  readonly accounts: readonly AccountRecord[];
  readonly selectedAccountKey: string | null;
  readonly linkedKeys: { readonly page: { readonly rows: readonly LinkedKey[]; readonly page: number; readonly hasNext: boolean }; readonly total: number } | null;
  readonly issuanceDefaults: readonly { readonly surface_grant: string; readonly account_id: string | null }[] | null;
  readonly retirement: RetirementPreview | null;
}

interface AccountRoutes {
  readonly start: string;
  readonly complete: string;
  readonly refresh: string;
  readonly logout: string;
  readonly startAction: string;
  readonly completeAction: string;
  readonly refreshAction: string;
  readonly logoutAction: string;
}

function serviceName(surface: string): string {
  if (surface === "codex") return "ChatGPT";
  if (surface === "grok") return "Grok";
  if (surface === "xai") return "xAI API";
  return "服务";
}

function defaultSurfaceName(grant: string): string {
  const surface = grant.split(":")[1] ?? "";
  if (surface === "codex") return "chatgpt";
  if (surface === "grok") return "grok";
  if (surface === "xai") return "xai";
  return "service";
}

function RetirementImpact({ model }: { readonly model: AccountsPageModel }) {
  if (!model.retirement) return <p className="caption" data-read-state="unavailable">暂时无法读取停用影响，请刷新后再确认关联密钥。</p>;
  const retirement = model.retirement;
  const account = model.accounts.find((account) => account.key === model.selectedAccountKey);
  if (!account) return null;
  const provider = account.provider;
  const path = `/admin/ui/${provider === "codex" ? "codex-auths" : "subscriptions"}/${encodeURIComponent(account.id)}`;
  const params = new URL(model.canonicalUrl, "https://dashboard.invalid").searchParams;
  const fields = <ReturnFields range={model.range.key} query={params.get("q") ?? ""} page={params.get("page") ?? "1"}/>;
  const migrating = retirement.live_keys.length > 0 || retirement.default_surfaces.length > 0;
  const keys = [...new Set(retirement.live_keys.map(key => key.id))].map(id => ({
    ...retirement.live_keys.find(key => key.id === id)!,
    grants: retirement.live_keys.filter(key => key.id === id).map(key => key.surface_grant)
  }));
  const migrationWarning = `迁移 ${account.label} 的所选密钥绑定和默认连接？这会改变未来请求的上游身份。服务商持有的文件、响应、任务和历史不会迁移。迁移后还需单独断开旧连接。`;
  const cleanupWarning = `重试清理 ${account.label} 的旧令牌？此操作不会恢复连接或更改密钥绑定。`;
  return (
    <section data-retirement="true" className="account-retirement-strip" aria-label="停用影响">
      {keys.length > 0 ? <p data-retirement-block="true">{`${formatNumber(keys.length)} 个未撤销密钥仍绑定此连接，需先处理绑定才能断开。`}</p> : <span className="caption">没有未撤销密钥绑定</span>}
      {retirement.status === "retiring" ? <p role="status">此连接正在停用，不能用于新绑定。请核对剩余绑定和默认连接，再断开旧连接。</p> : null}
      <InfoPopover id="account-retirement-help" label="停用影响" iconOnly><p>人员停用或密钥到期不会自动解除绑定，这里包括所有尚未撤销的密钥。</p><p>更改组织默认连接不会迁移现有密钥。服务商持有的文件、响应、任务和历史不会随账号停用或密钥换绑而迁移。</p>{retirement.shared_provider_authority ? <p>xAI API 使用组织的上游团队共享权限。控制台的个人权限不会隔离共享资源。</p> : null}</InfoPopover>
      {migrating && !["revoked","disabled"].includes(retirement.status) ? retirement.compatible_replacements.length ? (
        <details className="credential-migration-task">
          <summary>迁移绑定与默认连接</summary>
          <form method="post" action={`${path}/migrate`} data-action="credential-migrate" data-confirmation={migrationWarning} data-confirm-credential="">
            {fields}<input type="hidden" name="confirm" value="1"/>
            <Label htmlFor="retirement-replacement">替代连接</Label>
            <NativeSelect id="retirement-replacement" name="replacement_account_id" defaultValue="" required>
              <NativeSelectOption value="" disabled>请选择兼容连接</NativeSelectOption>
              {retirement.compatible_replacements.map(replacement => <NativeSelectOption key={replacement.id} value={replacement.id}>{presentText(replacement.label)} · {replacement.id}</NativeSelectOption>)}
            </NativeSelect>
            {keys.length ? <fieldset><legend>未撤销密钥及其在此连接的绑定</legend>{keys.map(key => <Label key={key.id} className="credential-migration-choice"><input type="checkbox" name="key_ids[]" value={key.id}/><span><code>{presentText(key.key_prefix)}</code> · {productAccessLabels(key.grants).join(" · ")}<span className="record-subline">{presentText(key.id)}</span></span></Label>)}</fieldset> : null}
            {retirement.default_surfaces.length ? <fieldset><legend>新密钥默认连接</legend>{retirement.default_surfaces.map(surface => <Label key={surface} className="credential-migration-choice"><input type="checkbox" name="default_surfaces[]" value={surface.split(":")[1]}/><span>{productAccessLabels([surface])[0]}</span></Label>)}</fieldset> : null}
            <p>迁移只更改所选绑定和默认连接。文件、响应、任务和历史不会迁移；完成后还需单独断开旧连接。</p>
            <ConfirmationFallback message={migrationWarning}/>
            <Button type="submit">迁移所选项目</Button>
          </form>
        </details>
      ) : <span className="caption">暂无可替换连接</span> : null}
      {retirement.status === "revoked" ? <form className="credential-cleanup-task" method="post" action={`${path}/cleanup`} data-action="credential-cleanup" data-confirmation={cleanupWarning}>{fields}<input type="hidden" name="confirm" value="1"/><p>连接已断开。如上次令牌清理未确认，可继续清理。</p><ConfirmationFallback message={cleanupWarning}/><Button type="submit" variant="outline">重试清理</Button></form> : null}
    </section>
  );
}

function ReturnFields({ range, query, page }: { readonly range: string; readonly query: string; readonly page: string }) {
  return (
    <>
      <input type="hidden" name="return_range" value={range} />
      <input type="hidden" name="return_q" value={query} />
      <input type="hidden" name="return_page" value={page} />
    </>
  );
}

function SteadyAction(props: {
  readonly action: AuthManagementAction;
  readonly routes: AccountRoutes;
  readonly secondary: boolean;
  readonly logoutConfirm: string;
  readonly reauthConfirm: string | null;
  readonly range: string;
  readonly query: string;
  readonly page: string;
  readonly disconnectBlock: string | null;
}) {
  const label = actionButtonLabel(props.action);
  const variant = props.secondary ? "outline" : "default";
  const fields = <ReturnFields range={props.range} query={props.query} page={props.page} />;
  switch (props.action) {
    case "connect":
      return <form className="inline-form" method="post" action={props.routes.start} data-action={props.routes.startAction}>{fields}<Button type="submit" variant={variant}>{label}</Button></form>;
    case "reauth":
      return (
        <form className="inline-form" method="post" action={props.routes.start} data-action={props.routes.startAction} data-confirmation={props.reauthConfirm ?? undefined}>
          {fields}
          {props.reauthConfirm ? <ConfirmationFallback message={props.reauthConfirm} /> : null}
          <Button type="submit" variant={variant}>{label}</Button>
        </form>
      );
    case "refresh":
      return (
        <form className="inline-form" method="post" action={props.routes.refresh} data-action={props.routes.refreshAction} data-credential-refresh="">
          <input type="hidden" name="confirm" value="1" />
          {fields}
          <Button type="submit" variant={variant}>{label}</Button>
        </form>
      );
    case "logout":
      return (
        <form className="inline-form" method="post" action={props.routes.logout} data-action={props.routes.logoutAction} data-confirmation={props.logoutConfirm}>
          {fields}
          {!props.disconnectBlock ? <ConfirmationFallback message={props.logoutConfirm} /> : null}
          <input type="hidden" name="confirm" value="1" />
          <Button type="submit" variant={variant} disabled={props.disconnectBlock !== null} title={props.disconnectBlock ?? undefined}>{label}</Button>
        </form>
      );
    case "continue_authorize":
    case "save_redirect":
    case "cancel":
      return null;
  }
}

function AuthorizingStrip(props: {
  readonly projection: AuthManagementProjection;
  readonly routes: AccountRoutes;
  readonly placeholder: string;
  readonly cancelUrl: string;
  readonly range: string;
  readonly query: string;
  readonly page: string;
}) {
  const { projection } = props;
  if (!projection.authorizeUrl || !projection.sessionId) return null;
  return (
    <div className="oauth-pending" data-authorizing="true" data-oauth-session={projection.sessionId}>
      <p className="credential-callout credential-oauth-guide" role="status">请在浏览器中完成登录，然后粘贴回调地址并保存。切换页面、取消或收起后需重新发起授权，回调地址不会保留。</p>
      <div className="credential-actions">
        <Button asChild>
          <a href={projection.authorizeUrl} data-oauth-open="true" target="_blank" rel="noopener noreferrer">{actionButtonLabel("continue_authorize")}</a>
        </Button>
        <Button asChild variant="outline">
          <a href={props.cancelUrl} data-dashboard-link="" data-action="oauth-cancel">{actionButtonLabel("cancel")}</a>
        </Button>
      </div>
      <form className="board-form credential-complete" method="post" action={props.routes.complete} data-action={props.routes.completeAction}>
        <ReturnFields range={props.range} query={props.query} page={props.page} />
        <input type="hidden" name="confirm" value="1" />
        <input type="hidden" name="session_id" value={projection.sessionId} />
        <Field control={{ label: "回调地址", name: "callback_url", type: "url", required: true, autoComplete: "off", autoFocus: true, placeholder: props.placeholder }} />
        <Button type="submit">{actionButtonLabel("save_redirect")}</Button>
      </form>
    </div>
  );
}

function IdentityCard(props: {
  readonly account: AccountRecord;
  readonly linkedTotal: number | null;
  readonly range: string;
  readonly query: string;
  readonly page: string;
  readonly cancelUrl: string;
  readonly closeHref: string;
  readonly impact: React.ReactNode;
  readonly disconnectBlock: string | null;
}) {
  const projection = { ...props.account.projection, label: props.account.provider === "codex" ? "ChatGPT" : "Grok" };
  const providerLabel = projection.label;
  const path = `/admin/ui/${props.account.provider === "codex" ? "codex-auths" : "subscriptions"}/${encodeURIComponent(props.account.id)}`;
  const routes: AccountRoutes = {
    start: `${path}/oauth/start`,
    complete: `${path}/oauth/complete`,
    refresh: `${path}/refresh`,
    logout: `${path}/logout`,
    startAction: `oauth-${props.account.provider}-start`,
    completeAction: `oauth-${props.account.provider}-complete`,
    refreshAction: `refresh-${props.account.provider}`,
    logoutAction: `logout-${props.account.provider}`
  };
  const logoutConfirm = `断开 ${providerLabel} · ${props.account.label}？已绑定的客户端在重新连接之前会失败。`;
  const reauthConfirm = projection.reauthReplacesActive ? `重新连接 ${providerLabel} · ${props.account.label}？这会替换当前的账号连接。` : null;
  const placeholder = props.account.provider === "codex"
    ? "http://localhost:1455/auth/callback?code=…&state=…"
    : "http://127.0.0.1:56121/callback?code=…&state=…";
  const titleId = `account-title-${props.account.provider}-${props.account.id}`;
  const order = [...projection.primaryActions, ...projection.secondaryActions];
  const hint = operatorHintForState(projection.state);
  return (
    <Card
      className="credential-card account-detail-content"
      data-codex-admin={props.account.provider === "codex" ? "true" : undefined}
      data-grok-admin={props.account.provider === "grok" ? "true" : undefined}
      data-account-id={props.account.id}
      data-credential-key={`${props.account.provider}:${props.account.id}`}
      data-credential-retrieve="oauth"
      data-mgmt-state={projection.state}
      data-oauth-pending={projection.state === "authorizing" ? "true" : undefined}
      aria-labelledby={titleId}
    >
      <div className="panel-head credential-card-head">
        <div className="credential-title-stack">
          <h2 id={titleId}>{presentText(props.account.label)}</h2>
          {projection.label?.trim() ? <span className="credential-title-label">{presentText(projection.label.trim())}</span> : null}
        </div>
        <div className="task-head-actions"><Badge data-credential-status="" className={`credential-status-meta tone-${statusToneForState(projection.state)}`}>{presentText(projection.statusLabel)}</Badge><TaskClose href={props.closeHref} label={projection.state === "authorizing" ? "放弃授权并收起连接详情" : "收起连接详情"}/></div>
      </div>
      <div className="credential-body">
        <p className="credential-callout" data-operator-hint="true" data-credential-hint="" role="status" hidden={!hint}>{hint}</p>
        <a data-credential-read-current="" data-dashboard-link="" href={props.cancelUrl} hidden>查看当前连接</a>
        <dl className="data-list compact credential-status" data-credential-dates="" hidden={!(projection.email || projection.expiresAt || projection.lastRefreshAt)}>
          {projection.email ? <div><dt>邮箱</dt><dd>{presentText(projection.email)}</dd></div> : null}
          <div data-credential-expiry="" hidden={!projection.expiresAt}><dt>{projection.state === "expired" ? "已过期" : "到期时间"}</dt><dd>{projection.expiresAt ? formatOperatorInstant(projection.expiresAt) : ""}</dd></div>
          <div data-credential-last-refresh="" hidden={!projection.lastRefreshAt}><dt>上次刷新</dt><dd>{projection.lastRefreshAt ? formatOperatorInstant(projection.lastRefreshAt) : ""}</dd></div>
        </dl>
        {props.linkedTotal === null ? null : (
          <nav className="section-links account-access-link" aria-label="账号访问">
            <a href="#account-keys">{`${formatNumber(props.linkedTotal)} 个关联密钥 `}<Icon name="arrow" /></a>
          </nav>
        )}
        {projection.state === "authorizing" ? (
          <AuthorizingStrip projection={projection} routes={routes} placeholder={placeholder} cancelUrl={props.cancelUrl} range={props.range} query={props.query} page={props.page} />
        ) : (
          <div className="credential-actions" data-mgmt-actions={order.join(" ")}>
            {order.map((action) => (
              <SteadyAction key={action} action={action} routes={routes} secondary={projection.secondaryActions.includes(action)} logoutConfirm={logoutConfirm} reauthConfirm={reauthConfirm} range={props.range} query={props.query} page={props.page} disconnectBlock={action === "logout" ? props.disconnectBlock : null} />
            ))}
          </div>
        )}
      </div>
      <fieldset className="oauth-task-controls" disabled={projection.state === "authorizing"}>{props.impact}</fieldset>
    </Card>
  );
}

function LinkedKeys(props: { readonly model: AccountsPageModel; readonly readOnly: boolean }) {
  const linked = props.model.linkedKeys;
  if (!linked) return null;
  return (
    <section id="account-keys" className="workspace-section account-linked-keys">
      <h2>关联的密钥</h2>
      {props.readOnly ? null : <InventoryPages base={props.model.canonicalUrl} page={linked.page.page} hasNext={linked.page.hasNext} field="page" label="关联密钥" anchor="account-keys" />}
      {linked.page.rows.length === 0 ? <p className="empty">{linked.total ? "这一页没有密钥。" : "没有密钥使用这个账号。"}</p> : (
        <ul className="linked-key-list" aria-label="关联密钥">
          {linked.page.rows.map((key) => {
            const grants = parseApiKeyScopes(key.scopes);
            const clients = key.bound_grants.map((grant) => `${productAccessLabels([grant])[0] ?? ""}${grants.includes(grant) ? "" : " — 未授予"}`).join(" · ");
            const href = inventoryUrl(props.model.canonicalUrl, { view: "access", person: key.user_id, key: key.id, account: null, q: null, page: null });
            const identity = <><span className="linked-key-identity"><strong>{presentText(personLabel({ id: key.user_id, email: key.user_email }))}</strong><span><code>{presentText(key.key_prefix)}</code> · {presentText(clients)}</span></span><span className="key-state">{keyStateLabel(key, key.user_status ? { status: key.user_status } : undefined, props.model.nowMs)}</span><Icon name="arrow" /></>;
            return (
              <li key={key.id} data-linked-key={key.id}>
                {props.readOnly ? <span className="linked-key-link" aria-disabled="true">{identity}</span> : <DashLink className="linked-key-link" href={href}>{identity}</DashLink>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DefaultAccounts({model}: {readonly model: AccountsPageModel}) {
  return <section data-default-boundary="true" className="account-defaults" aria-label="新密钥默认连接">
    <div className="panel-head"><h2>新密钥默认连接</h2><InfoPopover id="issuance-default-help" label="默认连接的影响" iconOnly><p>更改默认只影响新密钥。现有密钥继续使用原绑定，替换密钥复制原绑定。</p><p>Grok 与 xAI API 分别设置。xAI API 委托上游团队共享权限，个人权限不能隔离其资源。</p></InfoPopover></div>
    {model.issuanceDefaults === null ? <p data-read-state="unavailable" role="alert">新密钥默认连接暂时未读到。</p> : <Table data-issuance-defaults="true" scrollLabel="新密钥默认连接设置"><TableHeader><TableRow><TableHead>服务</TableHead><TableHead>连接</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{(["codex","grok","xai"] as const).map(surface=>{
      const grant = `surface:${surface}:production`;
      const row = model.issuanceDefaults!.find(row => row.surface_grant === grant);
      const provider = surface === "codex" ? "codex" : "grok";
      const options = model.accounts.filter(account => account.provider === provider);
      const current = options.find(account => account.id === row?.account_id);
      const name = surface === "codex" ? "Codex" : serviceName(surface);
      const params = new URL(model.canonicalUrl, "https://dashboard.invalid").searchParams;
      const formId = `default-${surface}`;
      const warning = `更改 ${name} 的新密钥默认连接？现有密钥保持原绑定，替换密钥复制原绑定。${surface === "xai" ? "xAI API 委托上游团队共享权限，个人权限不能隔离资源。" : ""}`;
      return <TableRow key={surface} data-default-surface={defaultSurfaceName(grant)}><TableCell>{name}</TableCell><TableCell>
        <form id={formId} className="credential-default-form" method="post" action={`/admin/ui/credential-defaults/${surface}`} data-action="credential-default" data-confirmation={warning} data-confirm-credential="">
          <ReturnFields range={model.range.key} query={params.get("q") ?? ""} page={params.get("page") ?? "1"}/>
          <input type="hidden" name="confirm" value="1"/>
          <Label className="sr-only" htmlFor={`${formId}-account`}>{`${name} 新密钥默认连接`}</Label>
          <NativeSelect id={`${formId}-account`} name="credential_account_id" defaultValue={current?.id ?? ""} required disabled={!options.some(account=>account.defaultEligible)}>
            <NativeSelectOption value="" disabled>{row?.account_id ? "当前连接未读到" : "未设置 · 请选择连接"}</NativeSelectOption>
            {options.map(account => <NativeSelectOption key={account.key} value={account.id} disabled={!account.defaultEligible}>{presentText(account.label)} · {account.projection.statusLabel} · {account.id}</NativeSelectOption>)}
          </NativeSelect>
          <ConfirmationFallback message={warning}/>
        </form>
        {!options.some(account=>account.defaultEligible) ? <span className="record-subline">请先连接兼容账号</span> : null}
      </TableCell><TableCell><Button type="submit" form={formId} variant="outline" aria-label={`保存 ${name} 默认连接`} disabled={!options.some(account=>account.defaultEligible)}>保存</Button></TableCell></TableRow>;
    })}</TableBody></Table>}
  </section>;
}

export function AccountsPage({ model }: { readonly model: AccountsPageModel }) {
  const search = new URL(model.canonicalUrl, "https://dashboard.invalid").searchParams;
  const adding = search.get("task") === "add-account";
  const query = search.get("q") ?? "";
  const page = search.get("page") ?? "1";
  const selected = model.accounts.find((account) => account.key === model.selectedAccountKey);
  const authorizing = selected?.projection.state === "authorizing";
  const matches = model.accounts.filter((account) => `${account.label} ${account.provider === "codex" ? "ChatGPT" : "Grok"} ${account.projection.statusLabel}`.toLowerCase().includes(query.toLowerCase()));
  const parentUrl = inventoryUrl(model.canonicalUrl, { account: null, task: null, page: null });
  const detail = adding || model.selectedAccountKey !== null;
  return (
    <section aria-label="账号" className="accounts-workspace" data-view-role="accounts" data-credential-admin="true" data-auth-management="lifecycle" data-show-detail={detail ? "true" : "false"}>
      <ObjectWorkspace task={detail ? (
        <div className="account-detail" id="account-detail" tabIndex={-1} data-account-detail={model.selectedAccountKey ?? ""}>
          {adding ? <Card className="account-create-task"><header className="task-card-head"><h2>添加账号</h2><TaskClose href={`${parentUrl}#accounts-list`} label="收起添加账号"/></header><AddAccountIsland control={{ range: model.range.key, query, page }} /></Card> : selected ? (
            <>
              <IdentityCard account={selected} linkedTotal={model.linkedKeys ? model.linkedKeys.total : null} range={model.range.key} query={query} page={page} cancelUrl={accountDashboardUrl(model.canonicalUrl, selected.key)} closeHref={`${parentUrl}#accounts-list`} impact={<RetirementImpact model={model}/>} disconnectBlock={model.retirement === null ? "请先重新读取停用影响" : model.retirement.live_keys.length > 0 ? "请先处理未撤销密钥绑定" : model.retirement.default_surfaces.length > 0 ? "请先处理默认连接" : null}/>
              <LinkedKeys model={model} readOnly={authorizing}/>
              {model.snapshot ? <section className="account-snapshot"><AccountDossier accountId={selected.id} snapshot={model.snapshot}/></section> : null}
            </>
          ) : (
            <Card className="workspace-section"><div className="task-card-head"><h2>没有这个账号</h2><TaskClose href={`${parentUrl}#accounts-list`} label="收起连接详情"/></div><p className="caption">这个账号已经不存在。</p></Card>
          )}
        </div>
      ) : null} collection={<aside id="accounts-list" className="accounts-index" tabIndex={-1} aria-label="账号列表">
        <div className="accounts-toolbar">
          {authorizing ? <Button disabled><Icon name="plus" />添加上游账号</Button> : <Button asChild><DashLink href={inventoryUrl(parentUrl, { task: "add-account" }, "account-detail")}><Icon name="plus" />添加上游账号</DashLink></Button>}
        </div>
        {authorizing ? <p role="status" className="caption">请先完成或取消当前授权。账号列表与其他设置暂时只读。</p> : null}
        <fieldset className="oauth-task-controls" disabled={authorizing}><InventorySearchView control={{...inventorySearchControl(model.canonicalUrl, "q", "page", "搜索账号", "accounts-list"),...(authorizing ? {clearHref:null} : {})}} /></fieldset>
        {query ? <p className="inventory-scope">{`${formatNumber(matches.length)} / ${formatNumber(model.accounts.length)} 个账号`}</p> : null}
        <ul className="account-list" aria-label="账号">
          {matches.length === 0 ? <li><p className="empty">{model.accounts.length ? "没有匹配的账号。" : "还没有账号。"}</p></li> : matches.map((account) => {
            const identity = <><span className="account-identity"><strong>{presentText(account.label)}</strong><small>{account.provider === "codex" ? "ChatGPT" : "Grok"}</small></span><Badge data-credential-status="" className={`account-state tone-${statusToneForState(account.projection.state)}`}>{presentText(account.projection.statusLabel)}</Badge><Icon name="arrow" /></>;
            return (
            <li key={account.key} data-account-key={account.key} data-credential-key={account.key}>
              {authorizing ? <span className="account-link" aria-disabled="true" aria-current={account.key === model.selectedAccountKey ? "true" : undefined}>{identity}</span> : <DashLink className="account-link" href={`${accountDashboardUrl(model.canonicalUrl, account.key)}#account-detail`} current={account.key === model.selectedAccountKey}>{identity}</DashLink>}
            </li>
          );})}
        </ul>
      </aside>}/>
      <fieldset className="oauth-task-controls" disabled={authorizing}><DefaultAccounts model={model}/></fieldset>
    </section>
  );
}
