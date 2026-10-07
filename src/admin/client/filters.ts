/** Filters only rows which the server has already authorized and rendered. */
export function initializeVisibleRowFilters(root: Pick<ParentNode, "querySelectorAll">): void {
  root.querySelectorAll<HTMLElement>('[data-visible-row-filter="true"]').forEach((filter) => {
    if (filter.dataset.visibleRowFilterReady === "true") return;
    const input = filter.querySelector<HTMLInputElement>("[data-visible-row-filter-input]");
    const table = filter.querySelector<HTMLTableElement>("[data-visible-row-filter-table] table");
    const list = table ? null : filter.querySelector<HTMLElement>("[data-filter-list]");
    const count = filter.querySelector<HTMLElement>("[data-visible-row-filter-count]");
    const empty = filter.querySelector<HTMLElement>("[data-visible-row-filter-empty]");
    if (!input || (!table && !list) || !empty) return;
    const rows = table ? Array.from(table.tBodies).flatMap((body) => Array.from(body.rows)) : Array.from(list?.children ?? []).filter((row): row is HTMLElement => row instanceof HTMLElement);
    const searchable = rows.map((row) => ({ row, text: (row.textContent ?? "").normalize("NFKC").toLocaleLowerCase() }));
    const apply = (): void => {
      const query = input.value.trim().normalize("NFKC").toLocaleLowerCase(); let visible = 0;
      searchable.forEach(({ row, text }) => { row.hidden = query !== "" && !text.includes(query); if (!row.hidden) visible++; });
      if (count) {
        count.textContent = query === "" ? `${visible} 条` : `显示 ${visible} / ${searchable.length} 条`;
        count.hidden = list !== null && query === "";
      }
      empty.hidden = visible !== 0;
    };
    input.addEventListener("input", apply); filter.dataset.visibleRowFilterReady = "true"; apply();
  });
}
