import { useEffect, useRef, useState } from "react";
import { Button } from "./components/button";
import { Input } from "./components/input";
import { Label } from "./components/label";
import { NativeSelect, NativeSelectOption } from "./components/native-select";
import { Checkbox } from "./components/checkbox";
import { Switch } from "./components/switch";
import { RadioGroup, RadioGroupItem } from "./components/radio-group";
import { useEnhanced } from "./use-enhanced";
import { ConfirmationFallback } from "./fields";
import { isCreditPolicyMode, type SelectControl, type CreditPolicyControl, type CreditPolicyMode, type AddAccountControl, type CheckControl, type AccessChoiceControl, type MemberKeyFormModel } from "./models";

export function SelectView({ control, onValueChange }: { readonly control: SelectControl; readonly onValueChange?: (value: string) => void }) {
  return <div className="radix-field">
    <Label htmlFor={control.id}>{control.label}</Label>
    <NativeSelect id={control.id} name={control.name} defaultValue={control.value} required={control.required} onChange={(event) => "value" in event.target && typeof event.target.value === "string" && onValueChange?.(event.target.value)}>
      {control.options.map((option) => <NativeSelectOption key={option.value} value={option.value} disabled={option.disabled}>{option.label}</NativeSelectOption>)}
    </NativeSelect>
  </div>;
}

function AccountReturnFields({ control }: { readonly control: AddAccountControl }) {
  return (
    <>
      <input type="hidden" name="return_range" value={control.range} />
      <input type="hidden" name="return_q" value={control.query} />
      <input type="hidden" name="return_page" value={control.page} />
    </>
  );
}

export function CreditPolicyForm({control, initialMode = control.mode}: {readonly control: CreditPolicyControl; readonly initialMode?: CreditPolicyMode}) {
  const enhanced = useEnhanced(); const [mode,setMode] = useState<CreditPolicyMode>(initialMode); const form = useRef<HTMLFormElement | null>(null);
  const warning = `更改 ${control.personLabel} 的 ${control.clientLabel} 额度？停用拒绝所有新请求；0 额度仍允许已授权的零消耗操作；不限取消月度额度上限。${control.clientLabel === "xAI API" ? "xAI API 使用上游团队共享资源，个人额度不能隔离这些资源。" : ""}`;
  useEffect(() => {
    const current = form.current; if (!current) return;
    const restore = (): void => {const field = current.elements.namedItem("mode"); if (field instanceof HTMLSelectElement && isCreditPolicyMode(field.value)) setMode(field.value);};
    restore(); current.addEventListener("console:restore", restore); return () => current.removeEventListener("console:restore", restore);
  }, []);
  return (
    <form ref={form} className="inline-form" method="post" action={control.action} data-action="credit-set" data-dashboard-draft="credit" data-confirmation={warning}>
      <SelectView
        control={{
          id: `${control.id}-mode`,
          name: "mode",
          label: "策略",
          required: true,
          value: initialMode,
          options: [
            { value: "limited", label: "限额", disabled: false },
            { value: "unlimited", label: "不限", disabled: false },
            { value: "disabled", label: "停用", disabled: false }
          ]
        }}
        onValueChange={(value) => {
          if (isCreditPolicyMode(value)) setMode(value);
        }}
      />
      <div className="credit-allowance" hidden={enhanced && mode !== "limited"}>
        <Label className="radix-field">
          每月额度
          <Input
            aria-label={`${control.clientLabel} 每月额度，人员 ${control.personLabel}`}
            name="monthly_allowance"
            type="number"
            min={0}
            step={1}
            required={enhanced && mode === "limited"}
            defaultValue={control.monthlyAllowance}
            placeholder="每月额度"
            disabled={enhanced && mode !== "limited"}
          />
        </Label>
      </div>
      <input type="hidden" name="confirm" value="1" />
      <ConfirmationFallback message={warning} />
      <Button type="submit">保存</Button>
    </form>
  );
}
export function CreditPolicySwitch({control,onEnable}: {readonly control: CreditPolicyControl; readonly onEnable: () => void}) {
  const enhanced = useEnhanced();
  if (control.mode === "disabled") return enhanced ? <Switch checked={false} aria-label={`${control.clientLabel} 请求准入`} onCheckedChange={onEnable}/> : <span className="caption">已停用</span>;
  const warning = `停用 ${control.personLabel} 的 ${control.clientLabel} 请求准入？所有新请求将被拒绝，包括零消耗操作。密钥不会撤销。`;
  return <form className="inline-form" method="post" action={control.action} data-action="credit-set" data-confirmation={warning}><input type="hidden" name="mode" value="disabled"/><input type="hidden" name="confirm" value="1"/><ConfirmationFallback message={warning}/><Switch type="submit" checked aria-label={`${control.clientLabel} 请求准入`} data-confirm-label={`停用 ${control.clientLabel}`} data-variant="destructive"/></form>;
}
export function AddAccountView({ control }: { readonly control: AddAccountControl }) {
  const enhanced = useEnhanced();
  const [kind, setKind] = useState<"chatgpt" | "grok">("chatgpt");
  return (
    <section className="workspace-section add-account" data-add-kind={enhanced ? kind : undefined}>
      {enhanced ? <RadioGroup className="add-kind-group" value={kind} aria-label="账号类型" onValueChange={(value) => { if (value === "chatgpt" || value === "grok") setKind(value); }}>
        <Label className="radix-check" htmlFor="add-chatgpt"><RadioGroupItem value="chatgpt" id="add-chatgpt" />ChatGPT</Label>
        <Label className="radix-check" htmlFor="add-grok"><RadioGroupItem value="grok" id="add-grok" />Grok</Label>
      </RadioGroup> : <p className="caption">选择下面的账号类型，填写名称后添加。</p>}
      <form className="board-form add-chatgpt" method="post" action="/admin/ui/codex-auths" aria-label="添加 ChatGPT 账号" data-dashboard-draft="account">
        {!enhanced ? <h3>ChatGPT</h3> : null}
        <AccountReturnFields control={control} />
        <Label>名称 <Input name="label" required autoComplete="off" placeholder="团队或负责人" /></Label>
        <Button type="submit">添加账号</Button>
      </form>
      <form className="board-form add-grok" method="post" action="/admin/ui/subscriptions" aria-label="添加 Grok 账号" data-dashboard-draft="account">
        {!enhanced ? <h3>Grok</h3> : null}
        <AccountReturnFields control={control} />
        <input type="hidden" name="capability_source" value="grok" />
        <input type="hidden" name="environment" value="production" />
        <Label>名称 <Input name="label" required autoComplete="off" placeholder="团队或负责人" /></Label>
        <Button type="submit">添加账号</Button>
      </form>
    </section>
  );
}

function FormCheckbox({ option }: { readonly option: CheckControl }) {
  const enhanced = useEnhanced();
  const id = `check-${option.name}-${option.value}`;
  const [checked, setChecked] = useState(option.checked);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const field = input.current; if (!field) return;
    setChecked(field.checked);
    const form = field.form; if (!form) return;
    const restore = (): void => { if (input.current) setChecked(input.current.checked); };
    form.addEventListener("console:restore", restore);
    return () => form.removeEventListener("console:restore", restore);
  }, []);
  return <>
    {enhanced ? <Checkbox id={id} aria-label={option.label} checked={checked} disabled={option.disabled} onCheckedChange={(state) => setChecked(state === true)} /> : <input ref={input} id={id} type="checkbox" name={option.name} value={option.value} defaultChecked={option.checked} disabled={option.disabled} />}
    {enhanced ? <input ref={input} type="checkbox" name={option.name} value={option.value} checked={checked} disabled={option.disabled} hidden readOnly /> : null}
    <Label htmlFor={id}>{option.label}</Label>
  </>;
}

export function AccessChoiceView({ choice }: { readonly choice: AccessChoiceControl }) {
  const enhanced = useEnhanced(); const [checked, setChecked] = useState(false); const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const field = input.current; if (!field?.form) return;
    const restore = (): void => setChecked(field.checked); restore();
    const form = field.form; form.addEventListener("console:restore", restore);
    return () => form.removeEventListener("console:restore", restore);
  }, []);
  return <div className="access-choice" data-access-choice={choice.id} data-access-level={choice.accessLevel}>
    {enhanced ? <><Label htmlFor={`access-${choice.id}`}>{choice.label}</Label><Switch id={`access-${choice.id}`} checked={checked} onCheckedChange={setChecked} aria-label={`新密钥包含 ${choice.label}`}/><input ref={input} type="checkbox" name="clients" value={choice.id} checked={checked} hidden readOnly/></> : <FormCheckbox option={{name: "clients", value: choice.id, label: choice.label, checked: false, disabled: false}} />}
    <span className="access-choice-body">
      {choice.badge === null ? null : <span className="access-choice-badge">{choice.badge}</span>}
      <span className="access-choice-promise">{choice.description}</span>
    </span>
  </div>;
}

export function CheckboxView({ option }: { readonly option: CheckControl }) {
  return <div className="radix-check"><FormCheckbox option={option} /></div>;
}

export function MemberKeyForm({ model }: { readonly model: MemberKeyFormModel }) {
  return <form className="board-form member-create-editor" method="post" action={model.action ?? "/me/ui/keys"} data-member-key-create="true">
      <h2>创建密钥</h2>
      <input type="hidden" name="key_return" value={model.returnHref ?? "/admin?area=me&view=keys"}/>
      <input type="hidden" name="submission_id" value={model.submissionId ?? ""}/>
      {model.lead === null ? null : <p className="lede">{model.lead}</p>}
      <Label>
        名称
        <Input name="name" required maxLength={64} autoComplete="off" />
      </Label>
      <div className="choices">{model.surfaces.map((option) => <CheckboxView key={option.value} option={option} />)}</div>
      <SelectView control={model.expiry} />
      <div className="person-form-actions"><Button type="submit" disabled={!model.canCreate}>创建密钥</Button><Button asChild variant="ghost" hidden data-member-enhanced-only><a href={model.returnHref ?? "/admin?area=me&view=keys"} data-member-create-close>取消</a></Button></div>
    </form>
}
