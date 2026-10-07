import { useEffect, useRef, useState } from "react";
import { Button } from "./components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/collapsible";
import { Field } from "./fields";
import { Icon } from "./icon";
import { useEnhanced } from "./use-enhanced";

type CreationKind = "human" | "service";
export interface PeopleCreateControl {
  readonly returnHref: string;
  readonly initialKind: CreationKind | null;
  readonly error: { readonly kind: CreationKind; readonly value: string; readonly message: string } | null;
}

export function readPeopleCreate(value: unknown): PeopleCreateControl | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const control = value as PeopleCreateControl;
  const kind = (value: unknown) => value === "human" || value === "service";
  return typeof control.returnHref === "string" && /^\/(?:admin)?\?/.test(control.returnHref)
    && (control.initialKind === null || kind(control.initialKind))
    && (control.error === null || control.error && kind(control.error.kind)
      && typeof control.error.value === "string" && typeof control.error.message === "string") ? control : null;
}

export function PeopleCreateView({ control }: { readonly control: PeopleCreateControl }) {
  const enhanced = useEnhanced();
  const [active, setActive] = useState<CreationKind | null>(control.error?.kind ?? control.initialKind);
  return <div className="people-create">{(["human", "service"] as const).map(kind => <Creation key={kind} kind={kind} control={control}
    enhanced={enhanced} open={active === kind} onOpenChange={open => setActive(open ? kind : null)}/>)}</div>;
}

function Creation({ kind, control, enhanced, open, onOpenChange }: {
  readonly kind: CreationKind; readonly control: PeopleCreateControl; readonly enhanced: boolean;
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void;
}) {
  const service = kind === "service";
  const id = service ? "add-service" : "add-person";
  const label = service ? "创建服务账号" : "添加成员";
  const error = control.error?.kind === kind ? control.error : null;
  const form = useRef<HTMLFormElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (enhanced && open) form.current?.querySelector<HTMLInputElement>("input:not([type=hidden])")?.focus({ preventScroll: true });
  }, [enhanced, open]);
  return <Collapsible className="people-create-task" open={open} onOpenChange={onOpenChange}>
    {enhanced ? <CollapsibleTrigger asChild aria-controls={id}><Button ref={trigger} type="button" variant={service ? "outline" : "default"}><Icon name="plus"/>{label}</Button></CollapsibleTrigger>
      : <Button asChild variant={service ? "outline" : "default"}><a href={`${control.returnHref}&task=${id}#people-list`}><Icon name="plus"/>{label}</a></Button>}
    <CollapsibleContent forceMount hidden={!open} className="people-create-content" id={id} tabIndex={-1} aria-label={label}>
      <form ref={form} className="board-form people-create-form" method="post" action={service ? "/admin/ui/services" : "/admin/ui/users"} data-dashboard-draft={service ? "service" : "person"}>
        {error ? <p className="form-error" id={`${id}-error`} role="alert" data-mutation-input-error={service ? "" : undefined}>{error.message}</p> : null}
        {service ? <p className="people-create-hint" id={`${id}-hint`}>服务账号不能登录，初始额度均为停用。创建账号不会生成密钥。</p> : null}
        <Field control={{label:service ? "服务名称" : "组织邮箱",name:service ? "display_name" : "email",type:service ? "text" : "email",placeholder:service ? "例如：构建机器人" : undefined,
          required:true,maxLength:service ? 64 : 254,autoComplete:"off",value:error?.value ?? "",autoFocus:!enhanced && open,invalid:Boolean(error),describedBy:[error ? `${id}-error` : null,service ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined}}/>
        <div className="person-form-actions"><Button type="submit">{label}</Button>{enhanced ? <Button type="button" variant="ghost" onClick={() => {onOpenChange(false);trigger.current?.focus({preventScroll:true});}}>取消</Button>
          : <a className="action-link" href={`${control.returnHref}#people-list`}>取消</a>}</div>
      </form>
    </CollapsibleContent>
  </Collapsible>;
}
