import type { DashboardMutationFlash } from "../../dashboard-data";
import { MutationNotice } from "../mutation-notice";
import { parseApiKeyScopes } from "../../../auth/authenticate";
import { keyIsExpired, keyStateLabel } from "../../key-label";
import { formatOperatorInstant, personLabel, presentText } from "../../format";
import { PRODUCT_ACCESS, productAccessLabels } from "../../client-setup";
import type { DashboardKey, DashboardPage } from "../../inventory";
import { executionPlanPresentation } from "../../../plans/execution-plans";
import type { KeyClientVerificationRow } from "../../../db";
import { Button } from "../components/button";
import { DashLink } from "../chrome";
import { inventoryUrl } from "../href";
import { Icon } from "../icon";
import { configurationTargets, type ConfigurationHelpProps } from "../task-help";
import { inventorySearchControl } from "../inventory";
import { SetupWorkbenchIsland } from "../islands";
import { Card } from "../components/card";
import { SetupKeyChoices, type SetupKeyInventoryControl } from "../setup-key-inventory";
import { TaskClose } from "../task-workspace";

interface SetupUser {
  readonly id: string;
  readonly status: string;
  readonly account_kind?: string;
}
export interface SetupPageModel {
  readonly canonicalUrl: string;
  readonly range: { readonly key: string };
  readonly nowMs: number;
  readonly selectedPersonId: string | null;
  readonly selectedKeyId: string | null;
  readonly selectedKey: DashboardKey | null;
  readonly users: readonly SetupUser[];
  readonly keys: readonly DashboardKey[];
  readonly keyPage: Pick<DashboardPage<DashboardKey>, "page" | "hasNext">;
  readonly verifications: readonly KeyClientVerificationRow[];
  readonly mutationFlash?: DashboardMutationFlash | null;
}

function freshAccessHref(userId: string, range: string, base: string): string {
  return inventoryUrl(base, {view:"access",range,person:userId,task:"give-access",key:null,q:null,page:null}, "give-access");
}
function verificationText(client: string, verifications: readonly KeyClientVerificationRow[], userId: string, keyId: string) {
  const rows = verifications.filter(row=>row.user_id===userId && row.key_id===keyId && executionPlanPresentation(row.route_profile_id).clientLabel===client);
  const latestSuccess = rows.map(row=>row.last_success_at).filter((value): value is string=>Boolean(value)).sort().at(-1) ?? null;
  const latestFailure = rows.map(row=>row.last_failure_at).filter((value): value is string=>Boolean(value)).sort().at(-1) ?? null;
  if (latestFailure && (!latestSuccess || latestFailure>latestSuccess)) return {result:"failed" as const,text:"最近任务失败 "+formatOperatorInstant(latestFailure)};
  if (latestSuccess) return {result:"works" as const,text:"最近任务成功 "+formatOperatorInstant(latestSuccess)};
  return {result:"not-verified" as const,text:"尚无任务请求记录"};
}
function localFiles() {
  return configurationTargets(Object.values(PRODUCT_ACCESS).map(access=>access.grant));
}

function SetupDetail({model,closeHref,held}: {readonly model: SetupPageModel; readonly closeHref: string; readonly held: boolean}) {
  const key = model.selectedKey;
  const person = model.users.find(user=>user.id===model.selectedPersonId);
  if (!key || !person) return <Card className="workspace-section" data-setup-missing=""><div className="task-card-head"><h2>没有这个密钥</h2><TaskClose href={closeHref} label="收起密钥配置"/></div><p className="caption">这个人没有这个密钥。</p></Card>;
  const files = configurationTargets(parseApiKeyScopes(key.scopes));
  const expired = keyIsExpired(key,model.nowMs);
  const justCreated = (model.mutationFlash?.kind==="key_created" || model.mutationFlash?.kind==="key_replacement_created") && model.mutationFlash.key_id===key.id;
  const replace = !justCreated && key.status==="active" && !expired;
  return <SetupWorkbenchIsland control={{id:"setup-workbench",localFiles:localFiles(),initialMode:held?"held":undefined,selected:{
    id:key.id,owner:presentText(personLabel(person)),name:key.name ?? "未命名密钥",prefix:presentText(key.key_prefix),
    state:key.status!=="active"?"revoked":expired?"expired":person.status!=="active"?"paused":"active",status:keyStateLabel(key,person,model.nowMs),files,hideTemplates:justCreated,
    verifications:files.map(file=>({client:file.client,...verificationText(Object.values(PRODUCT_ACCESS).find(access=>access.id===file.client)!.label,model.verifications,person.id,key.id)})),
    closeHref,heldHref:inventoryUrl(model.canonicalUrl,{task:"sync-configuration"},"setup-detail"),selectedHref:inventoryUrl(model.canonicalUrl,{task:null},"setup-detail"),manageHref:inventoryUrl(model.canonicalUrl,{view:"access",q:null,page:null,task:null}),
    newKeyHref:!justCreated && key.status==="active" && expired ? freshAccessHref(person.id,model.range.key,model.canonicalUrl) : undefined,
    replacement:replace ? {action:"/admin/ui/keys/"+encodeURIComponent(key.id)+"/replace",returnHref:model.canonicalUrl,confirmation:"为 "+key.key_prefix+" 换发密钥并下载配置包？这会创建一个新密钥。换发不会自动撤销原密钥。请先保存文件，再验证客户端。"} : undefined
  }}}/>;
}
export function SyncTask({recoveryHref}: ConfigurationHelpProps) {
  return <SetupWorkbenchIsland control={{id:"setup-workbench",localFiles:localFiles(),recovery:recoveryHref?{keys:recoveryHref("keys"),quota:recoveryHref("quota")}:undefined}}/>;
}
export function SetupPage({model}: {readonly model: SetupPageModel}) {
  const query = new URL(model.canonicalUrl,"https://dashboard.invalid").searchParams;
  const syncing = query.get("task")==="sync-configuration";
  const parentUrl = inventoryUrl(model.canonicalUrl,{person:null,key:null,task:null});
  const previousHref = model.keyPage.page>1 ? inventoryUrl(model.canonicalUrl,{page:model.keyPage.page===2?null:String(model.keyPage.page-1)},"setup-list") : null;
  const nextHref = model.keyPage.hasNext ? inventoryUrl(model.canonicalUrl,{page:String(model.keyPage.page+1)},"setup-list") : null;
  const pickerControl: SetupKeyInventoryControl = {selectedId:model.selectedKeyId,search:inventorySearchControl(model.canonicalUrl,"q","page","搜索账号或密钥","setup-list"),page:model.keyPage.page,previousHref,nextHref,choices:model.keys.map(key=>{
    const person = model.users.find(user=>user.id===key.user_id);
    return {id:key.id,href:inventoryUrl(parentUrl,{person:key.user_id,key:key.id},"setup-detail"),owner:presentText(personLabel(person,key.user_id)),name:key.name,kind:person?.account_kind==="service"?"service":"human",prefix:presentText(key.key_prefix),clients:productAccessLabels(parseApiKeyScopes(key.scopes)).join(" · ")||"无服务权限",state:key.status!=="active"?"revoked":keyIsExpired(key,model.nowMs)?"expired":person!==undefined && person.status!=="active"?"paused":"active",status:keyStateLabel(key,person,model.nowMs)};
  })};
  const selectedPerson = model.users.find(person=>person.id===model.selectedPersonId);
  return <section aria-label="连接客户端" className="setup-workspace" data-view-role="setup" id="setup-detail" tabIndex={-1}>
    <MutationNotice flash={model.mutationFlash}/>
    <header className="setup-page-head"><h2>连接客户端</h2><Button asChild variant="outline"><DashLink href={model.canonicalUrl}>刷新状态</DashLink></Button></header>
    <details className="setup-context-picker" id="setup-list" open={query.has("q") || model.keyPage.page>1}>
      <summary><span>账号与密钥</span><strong>{model.selectedKey ? presentText(personLabel(selectedPerson,model.selectedPersonId ?? ""))+" · "+(model.selectedKey.name ?? model.selectedKey.key_prefix) : "选择要配置的密钥"}</strong><Icon name="arrow"/></summary>
      <div className="setup-choice-card"><SetupKeyChoices control={pickerControl} showHeading={false}/>{model.keys.length===0 && !query.get("q") && model.keyPage.page===1 && !model.selectedKeyId ? <DashLink className="action-link" href={inventoryUrl(model.canonicalUrl,{view:"access",person:null,key:null,task:null,q:null,page:null})}>创建新密钥 <Icon name="arrow"/></DashLink> : null}</div>
    </details>
    <div className="setup-detail" data-setup-detail={model.selectedKeyId ?? ""}>{model.selectedKeyId ? <SetupDetail model={model} held={syncing} closeHref={parentUrl+"#setup-list"}/> : <SyncTask/>}</div>
  </section>;
}
