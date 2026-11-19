import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Ban, BookOpen, CalendarDays, ChevronDown, ContactRound, FileText, Folder, Grid3X3, MessagesSquare, Search, Table2, Workflow } from "lucide-react";
import { Button } from "./components/button";
import { Checkbox } from "./components/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/collapsible";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./components/input-group";
import { NativeSelect, NativeSelectOption } from "./components/native-select";

export interface FeishuChoice {
  name: string;
  title: string;
  description?: string;
  docsUrl?: string;
  scopes: string[];
  alternatives?: boolean;
  supplementalScopes?: string[];
  authority: string;
  enabled?: boolean;
}
export interface FeishuGroup { name: string; title: string; tools: FeishuChoice[] }

function ToolDetails({ tool }: { tool: FeishuChoice }) {
  return <div className="feishu-tool-permissions">
    {tool.description && <p data-feishu-description="">{tool.description}</p>}
    <div>
      <p>{tool.scopes.length
        ? tool.alternatives ? "所需应用权限（任选一项）" : "所需应用权限"
        : "官方权限目录暂无此项记录"}</p>
      <div className="feishu-scope-list">{tool.scopes.map(scope =>
        <code data-feishu-scope="" key={scope}>{scope}</code>)}</div>
    </div>
    {tool.supplementalScopes?.length ? <div>
      <p>知识库链接可能需要</p>
      <div className="feishu-scope-list">{tool.supplementalScopes.map(scope =>
        <code data-feishu-extra-scope="" key={scope}>{scope}</code>)}</div>
    </div> : null}
    {tool.docsUrl && <a data-feishu-doc="" href={tool.docsUrl} target="_blank" rel="noreferrer">飞书 API 文档</a>}
  </div>;
}

function ToolIdentity({ tool, titleId, group, checked }: {
  tool: FeishuChoice; titleId: string; group?: string; checked?: boolean;
}) {
  const name = tool.title === tool.name
    ? <code id={titleId} className="feishu-tool-api-name">{tool.name}</code>
    : <strong id={titleId}>{tool.title}</strong>;
  return <div className="feishu-tool-identity">
    <div className="feishu-tool-name">
      {tool.enabled === undefined ? name : <label htmlFor={`${titleId}-check`}>{name}</label>}
      <span className="caption" data-feishu-authority="">{tool.authority}</span>
      {tool.enabled === undefined && <span className="feishu-tool-unavailable">暂不可用</span>}
      {checked !== undefined && checked !== tool.enabled &&
        <span className="feishu-tool-draft">{checked ? "待启用" : "待关闭"}</span>}
    </div>
    {tool.title !== tool.name && <code className="feishu-tool-id">{tool.name}</code>}
    {group && <span className="caption">{group}</span>}
  </div>;
}

function NativeToolRow({ tool }: { tool: FeishuChoice }) {
  const titleId = useId();
  return <li className="feishu-tool-row" data-feishu-choice={tool.name} data-feishu-title={tool.title}
    data-feishu-alternatives={tool.alternatives || undefined}>
    <div className="feishu-tool-line">
      {tool.enabled !== undefined
        ? <input id={`${titleId}-check`} type="checkbox" aria-labelledby={titleId} name={`tool.${tool.name}`} value="1" defaultChecked={tool.enabled}/>
        : <Ban className="feishu-tool-unavailable-icon" aria-hidden="true"/>}
      <ToolIdentity tool={tool} titleId={titleId}/>
    </div>
    <details className="feishu-native-details">
      <summary>权限详情</summary>
      <ToolDetails tool={tool}/>
    </details>
  </li>;
}

export function NativeFeishuToolTree({ groups }: { groups: FeishuGroup[] }) {
  return <div data-feishu-tool-tree="">
    {groups.map((group, index) => <details key={group.name} open={index === 0}
      data-feishu-group={group.name} data-feishu-title={group.title}>
      <summary>{group.title} · {group.tools.length} 项</summary>
      <ul className="feishu-tool-results">{group.tools.map(tool => <NativeToolRow key={tool.name} tool={tool}/>)}</ul>
    </details>)}
    <div className="feishu-tool-actions"><Button type="submit">保存工具设置</Button></div>
  </div>;
}

/** Enhance the native form without sending the catalog twice. */
export function readNativeFeishuToolTree(root: HTMLElement): FeishuGroup[] {
  const list = (row: Element, selector: string) => Array.from(row.querySelectorAll(selector), node => node.textContent ?? "");
  return Array.from(root.querySelectorAll<HTMLElement>("[data-feishu-group]"), group => ({
    name: group.dataset.feishuGroup ?? "",
    title: group.dataset.feishuTitle ?? "",
    tools: Array.from(group.querySelectorAll<HTMLElement>("[data-feishu-choice]"), row => ({
      name: row.dataset.feishuChoice ?? "",
      title: row.dataset.feishuTitle ?? "",
      description: row.querySelector("[data-feishu-description]")?.textContent ?? undefined,
      docsUrl: row.querySelector<HTMLAnchorElement>("[data-feishu-doc]")?.href,
      scopes: list(row, "[data-feishu-scope]"),
      supplementalScopes: list(row, "[data-feishu-extra-scope]"),
      alternatives: row.dataset.feishuAlternatives === "true",
      authority: row.querySelector("[data-feishu-authority]")?.textContent ?? "",
      enabled: row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
    })),
  }));
}

const ALL_DOMAINS = "";
const RESULT_LIMIT = 25;
const DOMAIN_ICONS = new Map([
  [ALL_DOMAINS, Grid3X3], ["hosted", Workflow], ["docx", FileText], ["wiki", BookOpen],
  ["bitable", Table2], ["calendar", CalendarDays], ["contact", ContactRound], ["im", MessagesSquare],
]);
const STATUS_OPTIONS = [
  ["all", "全部状态"], ["enabled", "已启用"], ["disabled", "未启用"], ["unavailable", "暂不可用"],
] as const;
type ToolStatus = typeof STATUS_OPTIONS[number][0];

function matchesStatus(tool: FeishuChoice, status: ToolStatus) {
  return status === "all" || (status === "unavailable" ? tool.enabled === undefined : tool.enabled === (status === "enabled"));
}

function ToolRow({ tool, group, checked, open, onOpen, onChecked }: {
  tool: FeishuChoice; group?: string; checked?: boolean; open: boolean;
  onOpen: (open: boolean) => void; onChecked: (checked: boolean) => void;
}) {
  const titleId = useId();
  return <li className="feishu-tool-row" data-draft={checked !== undefined && checked !== tool.enabled || undefined}>
    <Collapsible open={open} onOpenChange={onOpen}>
      <div className="feishu-tool-line">
        {tool.enabled === undefined
          ? <Ban className="feishu-tool-unavailable-icon" aria-hidden="true"/>
          : <Checkbox id={`${titleId}-check`} aria-labelledby={titleId} checked={checked} onCheckedChange={value => onChecked(value === true)}/>}
        <ToolIdentity tool={tool} titleId={titleId} group={group} checked={checked}/>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" aria-label={`${tool.title}的权限详情`}>
            {open ? "收起详情" : "权限详情"} <ChevronDown aria-hidden="true"/>
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent><ToolDetails tool={tool}/></CollapsibleContent>
    </Collapsible>
  </li>;
}

function ToolChanges({ enabled, added, removed }: { enabled: number; added: number; removed: number }) {
  const changes = [added && `新增 ${added} 项`, removed && `关闭 ${removed} 项`].filter(Boolean);
  return <span>已启用 <strong>{enabled}</strong> 项{changes.length > 0 && ` · ${changes.join("、")}待保存`}</span>;
}

export function FeishuToolTree({ groups }: { groups: FeishuGroup[] }) {
  const [search, setSearch] = useState("");
  const [browseDomain, setBrowseDomain] = useState(groups[0]?.name ?? ALL_DOMAINS);
  const [searchDomain, setSearchDomain] = useState(ALL_DOMAINS);
  const [status, setStatus] = useState<ToolStatus>("all");
  const [visibleCount, setVisibleCount] = useState(RESULT_LIMIT);
  const [openTool, setOpenTool] = useState<string>();
  const saved = useMemo(() => new Set(groups.flatMap(group => group.tools.filter(tool => tool.enabled).map(tool => tool.name))), [groups]);
  const [selected, setSelected] = useState(saved);
  const payload = useRef<HTMLDivElement>(null);
  const selectableNames = useMemo(() => groups.flatMap(group => group.tools
    .filter(tool => tool.enabled !== undefined).map(tool => tool.name)), [groups]);
  useLayoutEffect(() => {
    const controls = payload.current;
    const form = controls?.closest("form");
    if (!controls || !form) return;
    const restore = () => setSelected(new Set(Array.from(
      controls.querySelectorAll<HTMLInputElement>("input:checked"), input => input.name.slice("tool.".length))));
    form.addEventListener("console:restore", restore);
    return () => form.removeEventListener("console:restore", restore);
  }, []);
  const query = search.trim().toLowerCase();
  const domain = query ? searchDomain : browseDomain;
  const filtered = query !== "" || status !== "all";
  const results = useMemo(() => groups.flatMap(group => {
    if (domain && group.name !== domain) return [];
    const entireDomainMatches = !query || [group.name, group.title].some(value => value.toLowerCase().includes(query));
    return group.tools.filter(tool => matchesStatus(tool, status) &&
      (entireDomainMatches || [tool.name, tool.title, tool.description, ...tool.scopes, ...(tool.supplementalScopes ?? [])]
        .some(value => value?.toLowerCase().includes(query))))
      .map(tool => ({ tool, group: group.title }));
  }), [groups, domain, query, status]);
  const selectable = results.filter(({ tool }) => tool.enabled !== undefined);
  const selectedCount = selectable.filter(({ tool }) => selected.has(tool.name)).length;
  const bulkState = selectedCount === 0 ? false : selectedCount === selectable.length ? true : "indeterminate";
  const added = [...selected].filter(name => !saved.has(name)).length;
  const removed = [...saved].filter(name => !selected.has(name)).length;
  const dirty = added + removed > 0;
  const domainTitle = groups.find(group => group.name === domain)?.title ?? "全部工具";

  function changeTools(tools: FeishuChoice[], checked: boolean) {
    setSelected(previous => {
      const next = new Set(previous);
      for (const tool of tools) {
        if (checked) next.add(tool.name);
        else next.delete(tool.name);
      }
      return next;
    });
  }
  function selectDomain(name: string) {
    if (query) setSearchDomain(name);
    else setBrowseDomain(name);
    setVisibleCount(RESULT_LIMIT);
  }
  const visibleResults = results.slice(0, visibleCount);
  const changeSummary = <ToolChanges enabled={saved.size} added={added} removed={removed}/>;

  return <div className="feishu-tool-picker">
    <div className="feishu-tool-toolbar">
      <InputGroup>
        <InputGroupAddon><Search aria-hidden="true"/></InputGroupAddon>
        <InputGroupInput type="search" aria-label="搜索飞书工具" value={search} placeholder="搜索工具、业务域或应用权限"
          onChange={event => {
            const value = event.target.value;
            if (!query || !value.trim()) setSearchDomain(ALL_DOMAINS);
            setSearch(value);
            setVisibleCount(RESULT_LIMIT);
          }}
          onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }}/>
      </InputGroup>
      <NativeSelect aria-label="工具状态" value={status} onChange={event => {
        setStatus(event.target.value as ToolStatus);
        setVisibleCount(RESULT_LIMIT);
      }}>
        {STATUS_OPTIONS.map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
      </NativeSelect>
      <p className="feishu-toolbar-summary caption">{changeSummary}</p>
    </div>
    <div ref={payload} hidden>
      {selectableNames.map(name => <input key={name} type="checkbox" name={`tool.${name}`} value="1" checked={selected.has(name)} readOnly/>)}
    </div>
    <div className="feishu-tool-workspace">
      <div className="feishu-domain-picker">
        <label htmlFor="feishu-domain">业务域</label>
        <NativeSelect id="feishu-domain" value={domain} onChange={event => selectDomain(event.target.value)}>
          <NativeSelectOption value={ALL_DOMAINS}>全部工具</NativeSelectOption>
          {groups.map(group => <NativeSelectOption key={group.name} value={group.name}>{group.title}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <nav className="feishu-domain-list" aria-label="业务域">
        <h4>业务域</h4>
        <button type="button" aria-current={!domain ? "true" : undefined} onClick={() => selectDomain(ALL_DOMAINS)}>
          <Grid3X3 aria-hidden="true"/><span>全部工具</span>
        </button>
        {groups.map(group => {
          const Icon = DOMAIN_ICONS.get(group.name) ?? Folder;
          return <button type="button" key={group.name}
            aria-current={domain === group.name ? "true" : undefined} onClick={() => selectDomain(group.name)}>
            <Icon aria-hidden="true"/><span>{group.title}</span>
            {domain === group.name && <span className="feishu-domain-count">{group.tools.filter(tool => tool.enabled).length}/{group.tools.length}</span>}
          </button>;
        })}
      </nav>
      <div className="feishu-tool-list">
        <div className="feishu-results-head">
          <div>
            <h4>{domainTitle}</h4>
            <p className="caption" aria-live="polite">{results.length} 项 · 已启用 {results.filter(({ tool }) => tool.enabled).length} 项</p>
          </div>
          {selectable.length > 0 && <label className="feishu-bulk-choice">
            <Checkbox checked={bulkState} onCheckedChange={value => changeTools(selectable.map(({ tool }) => tool), value === true)}/>
            {filtered || !domain ? "批量启停当前结果" : "批量启停本组"} {selectable.length} 项
          </label>}
        </div>
        {visibleResults.length ? <div key={JSON.stringify([domain,status,query])} className="feishu-results-scroll"
          role="region" aria-label="飞书工具结果" tabIndex={0}>
          <ul aria-label="飞书工具列表" className="feishu-tool-results">
            {visibleResults.map(({ tool, group }) => <ToolRow key={tool.name} tool={tool} group={domain ? undefined : group}
              checked={tool.enabled === undefined ? undefined : selected.has(tool.name)}
              open={openTool === tool.name} onOpen={open => setOpenTool(open ? tool.name : undefined)}
              onChecked={checked => changeTools([tool], checked)}/>)}
          </ul>
          {visibleResults.length < results.length &&
            <div className="feishu-more-results"><Button type="button" variant="outline"
              onClick={() => setVisibleCount(count => count + RESULT_LIMIT)}>显示更多工具</Button></div>}
        </div> : <p className="feishu-empty-results" role="status">没有匹配的工具。</p>}
      </div>
    </div>
    <div className="feishu-tool-actions">
      <p role="status">{changeSummary}</p>
      <div>
        <Button type="button" variant="ghost" data-discard-draft="" disabled={!dirty} onClick={() => setSelected(saved)}>放弃更改</Button>
        <Button type="submit" disabled={!dirty}>保存工具设置</Button>
      </div>
    </div>
  </div>;
}
