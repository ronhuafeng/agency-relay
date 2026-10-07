import { Input } from "./components/input";
import { Label } from "./components/label";
import type { FieldControl, InventorySearchControl } from "./models";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./components/input-group";
import { Icon } from "./icon";
import { useId } from "react";
import { Field as FieldPrimitive, FieldLabel } from "./components/field";

export function ConfirmationFallback({ message }: { readonly message: string }) {
  return (
    <Label className="confirmation-fallback" data-confirmation-fallback="">
      <input type="checkbox" required />
      <span>{message}</span>
    </Label>
  );
}


export function KeyExpiryField() {
  return <><Field control={{label: "到期时间（UTC，可选）", name: "expires_at_utc", type: "datetime-local", min: "0001-01-01T00:00", max: "9999-12-31T23:59:59", step: "1"}} /><p className="caption">留空为 90 天；最长 365 天。新密钥使用这次选择的到期时间。</p></>;
}

export function Field({ control }: { readonly control: FieldControl }) {
  const id = useId();
  return (
    <FieldPrimitive className="radix-field" data-invalid={control.invalid || undefined}>
      <FieldLabel htmlFor={id}>{control.label}</FieldLabel>
      <Input
        id={id}
        name={control.name}
        type={control.type ?? "text"}
        defaultValue={control.value}
        placeholder={control.placeholder}
        required={control.required}
        autoComplete={control.autoComplete}
        maxLength={control.maxLength}
        inputMode={control.inputMode}
        pattern={control.pattern}
        min={control.min}
        max={control.max}
        step={control.step}
        autoFocus={control.autoFocus}
        aria-invalid={control.invalid ? "true" : undefined}
        aria-describedby={control.describedBy}
      />
    </FieldPrimitive>
  );
}


export function InventorySearchView({ control }: { readonly control: InventorySearchControl }) {
  return (
    <form
      className="inventory-search"
      method="get"
      action={control.action}
      data-dashboard-search="true"
      data-search-anchor={control.anchor}
      role="search"
      aria-label={control.label}
    >
      {control.hidden.map((field) => <input key={field.name} type="hidden" name={field.name} value={field.value} />)}
      <Label className="sr-only" htmlFor={control.id}>{control.label}</Label>
      <InputGroup><InputGroupAddon><Icon name="search" /></InputGroupAddon><InputGroupInput
        id={control.id}
        type="search"
        name={control.field}
        defaultValue={control.value}
        placeholder={control.label}
        aria-label={control.label}
        maxLength={256}
        autoComplete="off"
      /><InputGroupAddon align="inline-end"><InputGroupButton type="submit" variant="ghost" size="icon-sm" aria-label={control.label}><Icon name="arrow"/><span className="sr-only">搜索</span></InputGroupButton></InputGroupAddon></InputGroup>
      {control.clearHref === null ? null : <a className="action-link" data-dashboard-link="true" href={control.clearHref}>清除</a>}
    </form>
  );
}
