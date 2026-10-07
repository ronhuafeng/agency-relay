import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "./components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/collapsible";
import { Field, ConfirmationFallback } from "./fields";
import { SelectView } from "./forms";
import { Icon } from "./icon";
import { useEnhanced } from "./use-enhanced";
import type { FieldControl, SelectControl } from "./models";

export interface TaskEditorControl {
  readonly id: string;
  readonly label: string;
  readonly action: string;
  readonly submitLabel: string;
  readonly fields: readonly FieldControl[];
  readonly hidden: Readonly<Record<string, string>>;
  readonly select?: SelectControl;
  readonly confirmation?: string;
  readonly confirmEmail?: boolean;
  readonly draftKind?: "person";
  readonly draftScope?: string;
}
export function readTaskEditor(value: unknown): TaskEditorControl | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const control = value as TaskEditorControl;
  if (typeof control.id !== "string" || typeof control.label !== "string" || typeof control.action !== "string"
    || !/^\/(?:admin|me)(?:\/|$)/.test(control.action) || typeof control.submitLabel !== "string"
    || !Array.isArray(control.fields) || !control.fields.every(field => field && typeof field.name === "string"
      && typeof field.label === "string" && (field.value === undefined || typeof field.value === "string"))
    || !control.hidden || typeof control.hidden !== "object" || Array.isArray(control.hidden)
    || !Object.values(control.hidden).every(value => typeof value === "string")) return null;
  if (control.select !== undefined && (!control.select || !Array.isArray(control.select.options)
    || !control.select.options.every(option => option && typeof option.value === "string" && typeof option.label === "string" && typeof option.disabled === "boolean")
    || typeof control.select.name !== "string" || typeof control.select.id !== "string"
    || typeof control.select.label !== "string" || typeof control.select.value !== "string" || typeof control.select.required !== "boolean")) return null;
  if (control.confirmation !== undefined && typeof control.confirmation !== "string"
    || control.confirmEmail !== undefined && typeof control.confirmEmail !== "boolean"
    || control.draftKind !== undefined && control.draftKind !== "person"
    || control.draftScope !== undefined && (typeof control.draftScope !== "string" || !control.draftScope)) return null;
  return control;
}
/** A task stays mounted while collapsed, so drafts and native forms keep their meaning. */
export function TaskEditorView({control}: {readonly control: TaskEditorControl}) {
  const enhanced = useEnhanced(); const [open, setOpen] = useState(control.fields.some(field=>field.invalid));
  const [hasDraft, setHasDraft] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const form = useRef<HTMLFormElement | null>(null);
  useLayoutEffect(() => {
    const current = form.current; if (!current || control.draftKind !== "person") return;
    const listeners = new AbortController();
    const update = (restore: boolean): void => queueMicrotask(() => {
      if (listeners.signal.aborted || !current.isConnected) return;
      const dirty = Boolean(current.querySelector('[data-draft-state]:not([hidden])'));
      setHasDraft(dirty); if (restore && dirty) setOpen(true);
    });
    // The draft owner updates its marker after the input/restore event. Read it
    // at that event's end, without introducing another field or storage model.
    current.addEventListener("input", () => update(false), {signal:listeners.signal});
    current.addEventListener("change", () => update(false), {signal:listeners.signal});
    current.addEventListener("console:restore", () => update(true), {signal:listeners.signal});
    return () => listeners.abort();
  }, [control.draftKind]);
  return <Collapsible className="task-editor" open={!enhanced || open} onOpenChange={setOpen}>
    {enhanced ? <CollapsibleTrigger asChild><Button ref={trigger} type="button" variant="ghost"><Icon name="edit"/>{control.label}</Button></CollapsibleTrigger> : <h3>{control.label}</h3>}
    {enhanced && !open && hasDraft ? <span className="caption" data-task-draft-indicator="" role="status">有未保存的修改</span> : null}
    <CollapsibleContent forceMount hidden={enhanced && !open}>
      <form ref={form} className="board-form task-editor-form" method="post" action={control.action} data-dashboard-draft={control.draftKind} data-draft-scope={control.draftScope} data-confirmation={control.confirmation} data-confirm-email={control.confirmEmail ? "" : undefined}>
        {Object.entries(control.hidden).map(([name,value]) => <input key={name} type="hidden" name={name} value={value}/>)}
        {control.fields.map(field => <Field key={field.name} control={field}/>)}
        {control.select ? <SelectView control={control.select}/> : null}
        {control.confirmation ? <ConfirmationFallback message={control.confirmation}/> : null}
        <div className="person-form-actions"><Button type="submit">{control.submitLabel}</Button>{enhanced ? <Button type="button" variant="ghost" onClick={() => {setOpen(false);trigger.current?.focus({preventScroll:true});}}>取消</Button> : null}</div>
      </form>
    </CollapsibleContent>
  </Collapsible>;
}
