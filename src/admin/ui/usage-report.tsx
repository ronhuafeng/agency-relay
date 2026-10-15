import { Button } from "./components/button";
import type { UsageRecord, UsageReportControl } from "./models";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/table";

function costFact(record: UsageRecord) {
  return record.metrics.find(metric => metric.metric === "cost");
}

function Record({record, costColumn}: {readonly record: UsageRecord; readonly costColumn: boolean}) {
  const count = record.metrics.find(metric=>metric.metric === "count");
  const measured = record.metrics.find(metric => metric.metric === "measurement");
  const failed = record.details.find(fact => fact.metric === "failure");
  const cost = costFact(record);
  const detailId = `usage-detail-${record.id}`;
  const partial = [measured,cost,...record.details].some(fact=>fact?.coverage && fact.coverage.recorded>0 && fact.coverage.recorded<fact.coverage.total);
  return (
    <TableRow role="row" className="usage-record" data-subscription-authority={record.authority} data-usage-plan={record.plan}>
      <TableCell role="cell" className="usage-record-identity"><Button type="button" variant="ghost" className="usage-record-inspect" popoverTarget={detailId} aria-label={`查看用量详情：${record.service} · ${record.title} · ${record.owner}`}><strong>{record.title === "N/A" ? "型号未记录" : record.title}</strong></Button><span className="record-subline">{record.service} · {record.owner}</span>{partial ? <span className="record-subline" data-usage-partial="">部分计量</span> : null}<aside id={detailId} popover="auto" className="console-help-popover" aria-label="用量详情"><header><h2>{record.service} · {record.title}</h2><Button type="button" variant="ghost" popoverTarget={detailId} popoverTargetAction="hide">关闭</Button></header>{cost ? <p data-cost-basis={cost.basis}><strong>{cost.label}</strong> · {cost.value}<br/>{cost.explanation}</p> : null}<dl className="usage-facts">{record.details.map((fact,index)=><div key={index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl></aside>{record.note ? <span className="record-subline">{record.note}</span> : null}</TableCell>
      <TableCell role="cell" className="number usage-record-count"><span className="mobile-field-label">{count?.label === "请求" ? "次请求" : count?.label}</span><strong>{count?.value ?? "—"}</strong></TableCell>
      <TableCell role="cell" className="number usage-record-measurement"><span className="mobile-field-label">{measured?.label}</span><strong>{measured?.value ?? "未记录"}</strong></TableCell>
      <TableCell role="cell" className="number usage-record-failure"><span className="mobile-field-label">失败</span><span data-tone={failed && failed.value !== "0" ? "bad" : undefined}>{failed?.value ?? "—"}</span></TableCell>
      {costColumn ? <TableCell role="cell" className="number usage-record-cost"><span className="mobile-field-label">参考费用</span><strong>{cost?.value ?? "—"}</strong></TableCell> : null}
    </TableRow>
  );
}
export function UsageReport({control}: {readonly control: UsageReportControl}) {
  const costColumn = control.records.some(record => costFact(record) !== undefined);
  return (
    <section aria-label="用量" className="usage-report view-stack" data-dashboard-mode="observe" data-view-role="usage">
      {control.records.length > 0 ? <>
        {control.truncated ? <p className="usage-report-tools">当前列表未显示全部记录。</p> : null}
          <div className="table-wrap usage-detail-table"><Table role="table" aria-label="按人员和服务的用量"><TableHeader role="rowgroup"><TableRow role="row"><TableHead role="columnheader" scope="col">人员 / 模型</TableHead><TableHead role="columnheader" scope="col" className="number">请求 / 开始</TableHead><TableHead role="columnheader" scope="col" className="number">令牌 / 输出</TableHead><TableHead role="columnheader" scope="col" className="number">失败</TableHead>{costColumn ? <TableHead role="columnheader" scope="col" className="number">参考费用（USD）</TableHead> : null}</TableRow></TableHeader><TableBody role="rowgroup" className="usage-records">{control.records.map(record => <Record key={record.id} record={record} costColumn={costColumn} />)}</TableBody></Table></div>
        {control.truncated ? <p className="caption">{control.limitNote}</p> : null}
      </> : control.emptyLabel ? <p className="empty">{control.emptyLabel}</p> : null}
    </section>
  );
}
