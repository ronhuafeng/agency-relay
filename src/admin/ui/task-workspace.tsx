import type { ReactNode } from "react";
import { Button } from "./components/button";
import { DashLink } from "./chrome";
import { Icon } from "./icon";

/** Lists and their exact tasks share the document; neither owns a vertical scroller. */
export function ObjectWorkspace({collection, task, className = ""}: {readonly collection: ReactNode; readonly task?: ReactNode; readonly className?: string}) {
  return <div className={`object-workspace ${className}`} data-object-workspace=""><div className="object-workspace-layout" data-task-open={String(Boolean(task))}>
    <div className="object-workspace-collection">{collection}</div>
    {task ? <div className="object-workspace-task">{task}</div> : null}
  </div></div>;
}

export function TaskClose({href, label = "收起详情"}: {readonly href: string; readonly label?: string}) {
  return <Button asChild variant="ghost" size="icon"><DashLink href={href} ariaLabel={label} title={label} data-task-close=""><Icon name="close"/></DashLink></Button>;
}
