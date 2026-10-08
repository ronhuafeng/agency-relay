import type { UsageRecord, UsageReportControl } from "./models";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/table";

function costFact(record: UsageRecord) {
  return record.metrics.find(metric => metric.label === "API 费率折算" || metric.label === "上游计量金额");
}

function Record({record, costColumn}: {readonly record: UsageRecord; readonly costColumn: boolean}) {
  const count = record.metrics[0];
  const measured = record.metrics.find(metric => metric.label === "已记录令牌" || metric.label === "已记录输出");
  const failed = record.details.find(fact => fact.label === "失败请求" || fact.label === "失败");
  const cost = costFact(record);
  return (
    <TableRow role="row" className="usage-record" data-subscription-authority={record.authority} data-usage-plan={record.plan}>
      <TableCell role="cell" className="usage-record-identity"><strong>{record.title === "N/A" ? "型号未记录" : record.title}</strong><span className="record-subline">{record.owner}</span>{record.note ? <span className="record-subline">{record.note}</span> : null}</TableCell>
      <TableCell role="cell" className="number usage-record-count"><span className="mobile-field-label">{count?.label === "请求" ? "次请求" : count?.label}</span><strong>{count?.value ?? "—"}</strong></TableCell>
      <TableCell role="cell" className="number usage-record-measurement"><span className="mobile-field-label">{measured?.label}</span><strong>{measured?.value ?? "未记录"}</strong></TableCell>
      <TableCell role="cell" className="number usage-record-failure"><span className="mobile-field-label">失败</span><span data-tone={failed && failed.value !== "0" ? "bad" : undefined}>{failed?.value ?? "—"}</span></TableCell>
      {costColumn ? <TableCell role="cell" className="number usage-record-cost"><span className="mobile-field-label">金额</span><strong>{cost?.value ?? "—"}</strong></TableCell> : null}
    </TableRow>
  );
}
export function UsageReport({control}: {readonly control: UsageReportControl}) {
  const costColumn = control.records.some(record => costFact(record) !== undefined);
  return (
    <section aria-label="用量" className="usage-report view-stack" data-dashboard-mode="observe" data-view-role="usage">
      {control.records.length > 0 ? <>
        {control.truncated ? <p className="usage-report-tools">当前列表未显示全部记录。</p> : null}
          <div className="table-wrap usage-detail-table"><Table role="table" aria-label="按人员和服务的用量"><TableHeader role="rowgroup"><TableRow role="row"><TableHead role="columnheader" scope="col">人员 / 模型</TableHead><TableHead role="columnheader" scope="col" className="number">请求 / 开始</TableHead><TableHead role="columnheader" scope="col" className="number">令牌 / 输出</TableHead><TableHead role="columnheader" scope="col" className="number">失败</TableHead>{costColumn ? <TableHead role="columnheader" scope="col" className="number">金额（USD）</TableHead> : null}</TableRow></TableHeader><TableBody role="rowgroup" className="usage-records">{control.records.map(record => <Record key={record.id} record={record} costColumn={costColumn} />)}</TableBody></Table></div>
        {control.truncated ? <p className="caption">{control.limitNote}</p> : null}
      </> : <p className="empty">{control.emptyLabel}</p>}
    </section>
  );
}
