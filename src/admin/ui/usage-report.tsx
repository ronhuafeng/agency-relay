import { Button } from "./components/button";
import { InfoPopover } from "./components/info-popover";
import { VisibleRowFilter } from "./chrome";
import type { UsageFact, UsageRecord, UsageReportControl } from "./models";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/table";

function costFact(record: UsageRecord) {
  return record.metrics.find(metric => metric.label === "API 费率折算" || metric.label === "上游计量金额");
}

function Facts({facts}: {readonly facts: readonly UsageFact[]}) {
  return <dl className="usage-facts">{facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>;
}
function Record({record, costColumn}: {readonly record: UsageRecord; readonly costColumn: boolean}) {
  const count = record.metrics[0];
  const measured = record.metrics.find(metric => metric.label === "已记录令牌" || metric.label === "已记录输出");
  const failed = record.details.find(fact => fact.label === "失败请求" || fact.label === "失败");
  const cost = costFact(record);
  return (
    <TableRow role="row" className="usage-record" data-subscription-authority={record.authority} data-usage-plan={record.plan}>
      <TableCell role="cell" className="usage-record-identity"><strong>{record.title === "N/A" ? "型号未记录" : record.title}</strong><span className="record-subline">{record.owner}</span></TableCell>
      <TableCell role="cell" className="usage-record-service">{record.service}</TableCell>
      <TableCell role="cell" className="number usage-record-count"><span className="mobile-field-label">{count?.label}</span><strong>{count?.value ?? "—"}</strong></TableCell>
      <TableCell role="cell" className="number usage-record-measurement"><span className="mobile-field-label">{measured?.label}</span><strong>{measured?.value ?? "未记录"}</strong></TableCell>
      <TableCell role="cell" className="number usage-record-failure"><span className="mobile-field-label">失败</span><span data-tone={failed && failed.value !== "0" ? "bad" : undefined}>{failed?.value ?? "—"}</span></TableCell>
      {costColumn ? <TableCell role="cell" className="number usage-record-cost"><strong>{cost?.value ?? "—"}</strong>{cost ? <span className="record-subline">{cost.label}</span> : null}</TableCell> : null}
      <TableCell role="cell" className="usage-record-detail"><InfoPopover id={`usage-details-${record.id}`} label={`${record.service} · ${record.title} 用量明细`} iconOnly>{record.note ? <p>{record.note}</p> : null}<Facts facts={record.details}/></InfoPopover></TableCell>
    </TableRow>
  );
}
export function UsageReport({control}: {readonly control: UsageReportControl}) {
  const costColumn = control.records.some(record => costFact(record) !== undefined);
  return (
    <section aria-label="用量" className="usage-report view-stack" data-dashboard-mode="observe" data-view-role="usage">
      {control.records.length > 0 ? <>
        {control.truncated ? <p className="usage-report-tools">当前列表未显示全部记录。</p> : null}
        <VisibleRowFilter
          shownRowsOnly
          label="用量"
          placeholder={control.filterPlaceholder}
          countLabel={`${control.records.length} 条`}
          rowCount={control.records.length}
          action={<Button asChild variant="link"><a href={control.exportUrl} download="usage.json">导出数据</a></Button>}
        >
          <div className="table-wrap usage-detail-table"><Table role="table" aria-label="按人员和服务的用量"><TableHeader role="rowgroup"><TableRow role="row"><TableHead role="columnheader" scope="col">人员 / 模型</TableHead><TableHead role="columnheader" scope="col">服务</TableHead><TableHead role="columnheader" scope="col" className="number">请求 / 开始</TableHead><TableHead role="columnheader" scope="col" className="number">令牌 / 输出</TableHead><TableHead role="columnheader" scope="col" className="number">失败</TableHead>{costColumn ? <TableHead role="columnheader" scope="col" className="number">金额（USD）</TableHead> : null}<TableHead role="columnheader" scope="col"><span className="sr-only">明细</span></TableHead></TableRow></TableHeader><TableBody role="rowgroup" className="usage-records">{control.records.map(record => <Record key={record.id} record={record} costColumn={costColumn} />)}</TableBody></Table></div>
        </VisibleRowFilter>
        {control.truncated ? <p className="caption">{control.limitNote}</p> : null}
      </> : <p className="empty">{control.emptyLabel}</p>}
    </section>
  );
}
