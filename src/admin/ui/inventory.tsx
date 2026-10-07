import { inventoryUrl, DASHBOARD_PEOPLE_PAGE_SIZES } from "./href";
import { Icon } from "./icon";
import type { InventorySearchControl } from "./models";
import { Pagination, PaginationContent, PaginationItem, PaginationLink } from "./components/pagination";
import { NativeSelect } from "./components/native-select";
import { Button } from "./components/button";

export function inventorySearchControl(
  base: string,
  field: "q" | "key_q",
  pageField: "page" | "key_page",
  label: string,
  anchor: string
): InventorySearchControl {
  const url = new URL(base, "https://dashboard.invalid");
  const value = url.searchParams.get(field) ?? "";
  url.searchParams.delete(field);
  url.searchParams.delete(pageField);
  return {
    id: `search-${anchor}-${field}`,
    action: url.pathname,
    anchor,
    label,
    field,
    value,
    hidden: [...url.searchParams].map(([name, entry]) => ({ name, value: entry })),
    clearHref: value ? inventoryUrl(base, { [field]: null, [pageField]: null }, anchor) : null
  };
}

export function InventoryPages(props: {
  readonly base: string;
  readonly page: number;
  readonly hasNext: boolean;
  readonly pageSize?: number;
  readonly field: "page" | "key_page";
  readonly label: string;
  readonly anchor: string;
}) {
  if (props.pageSize === undefined && props.page === 1 && !props.hasNext) return null;
  const previous = props.page > 1
    ? inventoryUrl(props.base, { [props.field]: props.page === 2 ? null : String(props.page - 1) }, props.anchor)
    : null;
  const next = props.hasNext
    ? inventoryUrl(props.base, { [props.field]: String(props.page + 1) }, props.anchor)
    : null;
  const pages = (
    <Pagination className="inventory-pages" aria-label={`${props.label}分页`}><PaginationContent>
      {previous ? <PaginationItem><PaginationLink size="default" className="action-link" data-dashboard-link="" href={previous}><Icon name="back" />上一页</PaginationLink></PaginationItem> : null}
      <PaginationItem><span className="pagination-current" aria-current="page">{`第 ${props.page} 页`}</span></PaginationItem>
      {next ? <PaginationItem><PaginationLink size="default" className="action-link" data-dashboard-link="" href={next}>下一页<Icon name="arrow" /></PaginationLink></PaginationItem> : null}
    </PaginationContent></Pagination>
  );
  if (props.pageSize === undefined) return pages;
  const url = new URL(props.base, "https://dashboard.invalid");
  url.searchParams.delete("page_size");
  url.searchParams.delete(props.field);
  return <div className="inventory-pagination">
    <form className="inventory-page-size" method="get" action={`${url.pathname}#${props.anchor}`} data-dashboard-search="true" data-search-anchor={props.anchor} aria-label={`${props.label}每页数量`}>
      {[...url.searchParams].map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <label htmlFor={`page-size-${props.anchor}`}>每页</label>
      <NativeSelect id={`page-size-${props.anchor}`} name="page_size" defaultValue={String(props.pageSize)}>
        {DASHBOARD_PEOPLE_PAGE_SIZES.map(size => <option key={size} value={size}>{`${size} 条`}</option>)}
      </NativeSelect>
      <Button type="submit" variant="outline">应用</Button>
    </form>
    {pages}
  </div>;
}
