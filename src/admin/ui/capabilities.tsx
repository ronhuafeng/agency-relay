import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/table";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./components/collapsible";
import { useEnhanced } from "./use-enhanced";
import type { CapabilityComparisonModel } from "./models";

export function CapabilityComparison({ model }: { readonly model: CapabilityComparisonModel }) {
  const { view } = model;
  const enhanced = useEnhanced();
  const content = <>
        <div className="surface-capability-authorities" role="list" aria-label="服务权限模型">
          {view.surfaces.map((surface) => (
            <article key={surface.id} role="listitem" data-surface-authority={surface.id} data-access-level={surface.accessLevel}>
              <strong>{surface.label}</strong>
              <span className="capability-authority-label">{surface.authorityLabel}</span>
              <p>{surface.authorityNote}</p>
            </article>
          ))}
        </div>
        <div className="surface-capability-table-wrap">
          <Table className="surface-capability-table" aria-label="完整的客户端能力比较">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">能力</TableHead>
                {view.surfaces.map((surface) => (
                  <TableHead key={surface.id} scope="col" data-surface-column={surface.id}>
                    <span className="capability-surface-head"><strong>{surface.label}</strong><span>{surface.badge}</span></span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            {view.groups.map((group) => (
              <TableBody key={group.id} data-capability-group={group.id}>
                <TableRow className="capability-group-row"><TableHead scope="rowgroup" colSpan={4}>{group.label}</TableHead></TableRow>
                {group.rows.map((row) => (
                  <TableRow key={row.id} data-capability-id={row.id}>
                    <TableHead scope="row"><span className="capability-name"><strong>{row.label}</strong><span>{row.description}</span></span></TableHead>
                    {view.surfaces.map((surface) => {
                      const cell = row.cells[surface.id];
                      return (
                        <TableCell key={surface.id} data-surface-cell={surface.id} data-capability-state={cell.state}>
                          <span className="capability-mobile-surface" aria-hidden="true">{surface.label}</span>
                          {cell.state === "not_available"
                            ? <span className="capability-state" aria-label={cell.label}>—</span>
                            : <span className="capability-state">{cell.label}</span>}
                          {cell.detail === undefined ? null : <span className="capability-detail">{cell.detail}</span>}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            ))}
          </Table>
        </div>
        <a className="action-link" href={model.routesHref} data-dashboard-link="">查看路由</a>
  </>;
  if (!enhanced) return <details id="capabilities" className="surface-capability-view" data-surface-capability-view="true"><summary><strong>比较客户端能力</strong></summary><div className="surface-capability-body">{content}</div></details>;
  return <Collapsible id="capabilities" className="surface-capability-view" data-surface-capability-view="true"><CollapsibleTrigger className="radix-collapsible-trigger capability-trigger"><strong>比较客户端能力</strong></CollapsibleTrigger><CollapsibleContent className="surface-capability-body">{content}</CollapsibleContent></Collapsible>;
}
