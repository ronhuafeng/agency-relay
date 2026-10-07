import type { ComponentProps, ReactNode } from "react";
import { Label } from "./components/label";
import { Input } from "./components/input";
import { Icon, type IconName } from "./icon";
import { Card, CardContent, CardHeader } from "./components/card";

/** In-app navigation link. The attribute is how the shell intercepts clicks. */
export function DashLink({ current, action, ariaLabel, ...props }: ComponentProps<"a"> & {
  readonly current?: boolean;
  readonly action?: string;
  readonly ariaLabel?: string;
}) {
  return (
    <a
      {...props}
      data-dashboard-link=""
      data-action={action}
      aria-current={current ? "true" : props["aria-current"]}
      aria-label={ariaLabel ?? props["aria-label"]}
    >
      {props.children}
    </a>
  );
}

export function Panel(props: {
  readonly title: ReactNode;
  readonly icon?: IconName;
  readonly meta?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly panel?: string;
  readonly hidden?: boolean;
  readonly children?: ReactNode;
}) {
  const className = ["panel", props.className].filter(Boolean).join(" ");
  return (
    <Card className={className} data-panel={props.panel} hidden={props.hidden}>
      <CardHeader className="panel-head">
        <h3>
          {props.icon ? <Icon name={props.icon} /> : null}
          {props.icon ? " " : null}
          {props.title}
        </h3>
        {props.action}
        {props.meta !== undefined ? <span className="meta">{props.meta}</span> : null}
      </CardHeader>
      <CardContent>{props.children}</CardContent>
    </Card>
  );
}

/** Client-side row filter. An empty table is returned without the filter bar. */
export function VisibleRowFilter(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly countLabel: string;
  readonly rowCount: number;
  readonly shownRowsOnly?: boolean;
  readonly hideCount?: boolean;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  if (props.rowCount === 0) return props.children;
  return (
    <div className="visible-row-filter" data-visible-row-filter="true">
      <div className="visible-row-filter-bar">
        <Label>
          <span className="sr-only">{`过滤${props.label}`}</span>
          <Input
            type="search"
            inputMode="search"
            autoComplete="off"
            spellCheck={false}
            placeholder={props.shownRowsOnly ? `本页：${props.placeholder}` : props.placeholder}
            data-visible-row-filter-input=""
          />
        </Label>
        {props.hideCount ? null : <span className="meta" data-visible-row-filter-count="" aria-live="polite">{props.countLabel}</span>}
        {props.action}
      </div>
      {props.shownRowsOnly ? <p className="visible-row-filter-scope sr-only">只搜索当前列表。</p> : null}
      <div data-visible-row-filter-table="">{props.children}</div>
      <p className="empty" data-visible-row-filter-empty="" hidden>没有匹配的记录。</p>
    </div>
  );
}

export function View(props: {
  readonly label: string;
  readonly role: string;
  readonly mode: string;
  readonly className: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.label} className={props.className} data-dashboard-mode={props.mode} data-view-role={props.role}>
      {props.children}
    </section>
  );
}
