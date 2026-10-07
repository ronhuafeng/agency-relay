import { AddAccountView, AccessChoiceView, MemberKeyForm } from "./forms";
import { CopySecretView, DisclosureView } from "./secrets";
import { CapabilityComparison } from "./capabilities";
import { UsageReport } from "./usage-report";
import type { UsageReportControl } from "./models";
import type { AddAccountControl, AccessChoiceControl, MemberKeyFormModel, CopySecretControl, DisclosureControl, CapabilityComparisonModel } from "./models";
import { AccountMenuView, type AccountMenuControl } from "./account-menu";
import { SetupFilesView, type SetupFilesControl } from "./setup-files";
import { SetupWorkbenchView, type SetupWorkbenchControl } from "./setup-workbench";
import { RequestFiltersView, type RequestFiltersControl } from "./request-filters";
import { UsageComparison, type UsageComparisonControl } from "./usage-comparison";
import { TaskEditorView, type TaskEditorControl } from "./task-editor";
import { RoutesView, type RouteRow } from "./pages/routes";
import { CreditTableView, type CreditTableRow } from "./credit-table";
import { PeopleCreateView, type PeopleCreateControl } from "./people-create";

export function PeopleCreateIsland({control}: {readonly control: PeopleCreateControl}) {
  return <><div id="people-create-root"><PeopleCreateView control={control}/></div><IslandData id="people-create-props" kind="people-create" value={control}/></>;
}

export function CreditTableIsland({rows}: {readonly rows: readonly CreditTableRow[]}) {
  return <><div id="person-credit-table-root"><CreditTableView rows={rows}/></div><IslandData id="person-credit-table-props" kind="credit-table" value={rows}/></>;
}

export function TaskEditorIsland({control}: {readonly control: TaskEditorControl}) {
  return <><div id={`${control.id}-root`}><TaskEditorView control={control}/></div><IslandData id={`${control.id}-props`} kind="task-editor" value={control}/></>;
}
export function RoutesIsland({routes}: {readonly routes: readonly RouteRow[]}) {
  return <><div id="routes-root"><RoutesView routes={routes}/></div><IslandData id="routes-props" kind="routes" value={routes}/></>;
}

export function UsageComparisonIsland({control}: {readonly control: UsageComparisonControl}) {
  return <><div id={`${control.id}-root`}><UsageComparison control={control}/></div><IslandData id={`${control.id}-props`} kind="usage-comparison" value={control}/></>;
}

export function RequestFiltersIsland({control}: {readonly control: RequestFiltersControl}) {
  return <><div id="request-filters-root"><RequestFiltersView control={control}/></div><IslandData id="request-filters-props" kind="request-filters" value={control}/></>;
}

export function AccountMenuIsland({control}: {readonly control: AccountMenuControl}) {
  return <><div id="account-menu-root"><AccountMenuView control={control}/></div><IslandData id="account-menu-props" kind="account-menu" value={control}/></>;
}
export function SetupFilesIsland({control}: {readonly control: SetupFilesControl}) {
  const published = {id:control.id,clientSelectId:control.clientSelectId,files:control.files.map(({client,clientLabel,filename,installTarget,template})=>({client,clientLabel,filename,installTarget,template}))};
  return <><div id={`${control.id}-root`}><SetupFilesView control={published}/></div><IslandData id={`${control.id}-props`} kind="setup-files" value={published}/></>;
}
export function SetupWorkbenchIsland({control}: {readonly control: SetupWorkbenchControl}) {
  return <><div id={`${control.id}-root`}><SetupWorkbenchView control={control}/></div><IslandData id={`${control.id}-props`} kind="setup-workbench" value={control}/></>;
}

export function AddAccountIsland({ control }: { readonly control: AddAccountControl }) {
  return (
    <>
      <div id="add-account-root"><AddAccountView control={control} /></div>
      <IslandData id="add-account-props" kind="add-account" value={control} />
    </>
  );
}

export function AccessChoiceIsland({ choice }: { readonly choice: AccessChoiceControl }) {
  return (
    <>
      <div id={`access-choice-${choice.id}-root`}><AccessChoiceView choice={choice} /></div>
      <IslandData id={`access-choice-${choice.id}-props`} kind="access-choice" value={choice} />
    </>
  );
}

export function MemberKeyFormIsland({model}: {readonly model: MemberKeyFormModel}) {
  return <><div id="member-key-form"><MemberKeyForm model={model} /></div><IslandData id="member-key-form-props" kind="member-key-form" value={model} /></>;
}
export function CopySecretIsland({control}: {readonly control: CopySecretControl}) {
  return <><div id="copy-secret-root"><CopySecretView control={control} /></div><IslandData id="copy-secret-props" kind="copy-secret" value={control} /></>;
}
type IslandModel =
  | {readonly kind: "people-create"; readonly value: PeopleCreateControl}
  | {readonly kind: "credit-table"; readonly value: readonly CreditTableRow[]}
  | {readonly kind: "task-editor"; readonly value: TaskEditorControl}
  | {readonly kind: "routes"; readonly value: readonly RouteRow[]}
  | {readonly kind: "usage-comparison"; readonly value: UsageComparisonControl}
  | {readonly kind: "request-filters"; readonly value: RequestFiltersControl}
  | {readonly kind: "account-menu"; readonly value: AccountMenuControl}
  | {readonly kind: "setup-files"; readonly value: SetupFilesControl}
  | {readonly kind: "setup-workbench"; readonly value: SetupWorkbenchControl}
  | {readonly kind: "add-account"; readonly value: AddAccountControl}
  | {readonly kind: "access-choice"; readonly value: AccessChoiceControl}
  | {readonly kind: "member-key-form"; readonly value: MemberKeyFormModel}
  | {readonly kind: "copy-secret"; readonly value: CopySecretControl}
  | {readonly kind: "disclosure"; readonly value: DisclosureControl}
  | {readonly kind: "capability"; readonly value: CapabilityComparisonModel}
  | {readonly kind: "usage-report"; readonly value: UsageReportControl};
function IslandData({id, kind, value}: IslandModel & {readonly id: string}) {
  return <script type="application/json" id={id} data-ui-props={kind} dangerouslySetInnerHTML={{__html: JSON.stringify(value).replaceAll("<", "\\u003c")}} />;
}

export function UsageReportIsland({control}: {readonly control: UsageReportControl}) {
  return <><div id="usage-report"><UsageReport control={control} /></div><IslandData id="usage-report-props" kind="usage-report" value={control} /></>;
}

export function DisclosureIsland({control}: {readonly control: DisclosureControl}) {
  return <><div id={`${control.id}-root`}><DisclosureView control={control} /></div><IslandData id={`${control.id}-props`} kind="disclosure" value={control} /></>;
}

function publishedComparison(model: CapabilityComparisonModel): CapabilityComparisonModel {
  return {
    routesHref: model.routesHref,
    view: {
      surfaces: model.view.surfaces.map(({id, label, accessLevel, badge, authorityLabel, authorityNote}) => ({id, label, accessLevel, badge, authorityLabel, authorityNote})),
      groups: model.view.groups.map(({id, label, rows}) => ({id, label, rows: rows.map(({id, label, description, cells}) => ({id, label, description, cells: {
        codex: {state: cells.codex.state, label: cells.codex.label, detail: cells.codex.detail},
        grok: {state: cells.grok.state, label: cells.grok.label, detail: cells.grok.detail},
        xai: {state: cells.xai.state, label: cells.xai.label, detail: cells.xai.detail}
      }}))}))
    }
  };
}

export function CapabilityIsland({ model }: { readonly model: CapabilityComparisonModel }) {
  const published = publishedComparison(model);
  return (
    <>
      <div id="capability-comparison"><CapabilityComparison model={published} /></div>
      <IslandData id="capability-comparison-props" kind="capability" value={published} />
    </>
  );
}
