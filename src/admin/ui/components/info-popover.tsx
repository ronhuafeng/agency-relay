import type { ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Button } from "./button";

/** Native popover keeps contextual help available before hydration. */
export function InfoPopover({id,label,iconOnly=false,children}: {readonly id:string;readonly label:string;readonly iconOnly?:boolean;readonly children:ReactNode}) {
  return <div className="info-popover"><Button type="button" variant="ghost" size={iconOnly?"icon":"default"} aria-label={iconOnly?label:undefined} title={iconOnly?label:undefined} popoverTarget={id}><CircleHelp className="ui-icon" aria-hidden="true"/>{iconOnly?null:label}</Button><aside id={id} popover="auto" className="console-help-popover" aria-label={label}><header><h2>{label}</h2><Button type="button" variant="ghost" popoverTarget={id} popoverTargetAction="hide">关闭</Button></header>{children}</aside></div>;
}
