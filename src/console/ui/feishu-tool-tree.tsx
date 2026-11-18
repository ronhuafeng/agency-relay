import {useDeferredValue,useState,type ReactNode} from "react";
import {Checkbox} from "./components/checkbox";
import {Collapsible,CollapsibleContent,CollapsibleTrigger} from "./components/collapsible";
import {Input} from "./components/input";

export interface FeishuChoice {
  name:string;
  title:string;
  description?:string;
  docsUrl?:string;
  scopes:string[];
  alternatives?:boolean;
  supplementalScopes?:string[];
  authority:string;
  enabled?:boolean;
}
export interface FeishuGroup { name:string; title:string; tools:FeishuChoice[] }

export function FeishuToolRow({tool,control}:{tool:FeishuChoice;control?:ReactNode}){
  return <li className="break-words" data-feishu-choice={tool.name} data-feishu-title={tool.title} data-feishu-alternatives={tool.alternatives||undefined}>
    {control?<label>{control} {tool.title===tool.name?<code>{tool.name}</code>:<>{tool.title} <code>{tool.name}</code></>}</label>:<strong>{tool.title}</strong>}
    {tool.description||tool.docsUrl?<p><span data-feishu-description="">{tool.description}</span>{tool.docsUrl?<> · <a data-feishu-doc="" href={tool.docsUrl} target="_blank" rel="noreferrer">飞书 API 文档</a></>:null}</p>:null}
    <p className="caption">{tool.scopes.length?<>{tool.alternatives?"应用权限（任选一项）":"应用权限"} {tool.scopes.map(scope=><code data-feishu-scope="" className="record-subline" key={scope}>{scope}</code>)}</>:"官方权限目录暂无此项记录"}
      {tool.supplementalScopes?.map(scope=><span className="record-subline" key={scope}>知识库链接可能需要 <code data-feishu-extra-scope="">{scope}</code></span>)}</p>
    <p className="caption" data-feishu-authority="">{tool.authority}</p>
  </li>;
}

export function NativeFeishuToolTree({groups}:{groups:FeishuGroup[]}){
  return <div data-feishu-tool-tree="">
    {groups.map(group=><details key={group.name} data-feishu-group={group.name} data-feishu-title={group.title}>
      <summary>{group.title} · {group.tools.length} 项</summary>
      <ul>{group.tools.map(tool=><FeishuToolRow key={tool.name} tool={tool} control={tool.enabled!==undefined
        ?<input type="checkbox" name={`tool.${tool.name}`} value="1" defaultChecked={tool.enabled}/>:undefined}/>)}</ul>
    </details>)}
  </div>;
}

/** Read the already rendered native form, so enhancement needs no second catalog payload. */
export function readNativeFeishuToolTree(root:HTMLElement):FeishuGroup[]{
  const list=(row:Element,selector:string)=>Array.from(row.querySelectorAll(selector),node=>node.textContent??"");
  return Array.from(root.querySelectorAll<HTMLElement>("[data-feishu-group]"),group=>({
    name:group.dataset.feishuGroup??"",
    title:group.dataset.feishuTitle??"",
    tools:Array.from(group.querySelectorAll<HTMLElement>("[data-feishu-choice]"),row=>({
      name:row.dataset.feishuChoice??"",title:row.dataset.feishuTitle??"",
      description:row.querySelector("[data-feishu-description]")?.textContent??undefined,
      docsUrl:row.querySelector<HTMLAnchorElement>("[data-feishu-doc]")?.href,
      scopes:list(row,"[data-feishu-scope]"),supplementalScopes:list(row,"[data-feishu-extra-scope]"),
      alternatives:row.dataset.feishuAlternatives==="true",authority:row.querySelector("[data-feishu-authority]")?.textContent??"",
      enabled:row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
    })),
  }));
}

export function FeishuToolTree({groups}:{groups:FeishuGroup[]}){
  const [search,setSearch]=useState("");
  const query=useDeferredValue(search.trim().toLowerCase());
  const [selected,setSelected]=useState(()=>new Set(groups.flatMap(group=>group.tools.filter(tool=>tool.enabled).map(tool=>tool.name))));
  const matches=groups.flatMap(group=>{
    const tools=!query||group.title.toLowerCase().includes(query)?group.tools:group.tools.filter(tool=>
      [tool.name,tool.title,tool.description,...tool.scopes,...(tool.supplementalScopes??[])].some(value=>value?.toLowerCase().includes(query)));
    return tools.length?[{...group,tools}]:[];
  });
  const change=(names:readonly string[],checked:boolean)=>setSelected(previous=>{
    const next=new Set(previous);
    for(const name of names)if(checked)next.add(name);else next.delete(name);
    return next;
  });
  return <div className="space-y-3">
    <label htmlFor="feishu-tool-search">搜索飞书工具</label>
    <Input id="feishu-tool-search" type="search" value={search} placeholder="工具名、业务域或应用权限" onChange={event=>setSearch(event.target.value)}
      onKeyDown={event=>{if(event.key==="Enter")event.preventDefault();}}/>
    <p className="caption">已选 {selected.size} 项。{query?"组复选框只切换匹配的工具。":""}</p>
    {[...selected].map(name=><input key={name} type="hidden" name={`tool.${name}`} value="1"/>)}
    {matches.length?<ul aria-label="飞书工具树" className="space-y-2">{matches.map(group=>
      <li key={group.name}><FeishuTreeBranch group={group} selected={selected} query={query} change={change}/></li>
    )}</ul>:<p role="status">没有匹配的工具。</p>}
  </div>;
}

function FeishuTreeBranch({group,selected,query,change}:{group:FeishuGroup;selected:ReadonlySet<string>;query:string;change:(names:readonly string[],checked:boolean)=>void}){
  const [disclosure,setDisclosure]=useState<{query:string;open:boolean}>();
  const open=disclosure?.query===query?disclosure.open:Boolean(query);
  const choices=group.tools.filter(tool=>tool.enabled!==undefined);
  const count=choices.filter(tool=>selected.has(tool.name)).length;
  const checked=count===0?false:count===choices.length?true:"indeterminate";
  return <Collapsible open={open} onOpenChange={open=>setDisclosure({query,open})}>
    <div className="flex flex-wrap items-center gap-2">
      <CollapsibleTrigger className="radix-collapsible-trigger">{open?"▾":"▸"} {group.title} · {group.tools.length} 项</CollapsibleTrigger>
      {choices.length?<Checkbox aria-label={query?`切换 ${group.title} 的匹配工具`:`切换 ${group.title} 的所有工具`} checked={checked}
        onCheckedChange={value=>change(choices.map(tool=>tool.name),value===true)}/>:null}
    </div>
    <CollapsibleContent>
      <ul className="space-y-3 ps-4">{group.tools.map(tool=><FeishuToolRow key={tool.name} tool={tool} control={tool.enabled!==undefined
        ?<Checkbox checked={selected.has(tool.name)} onCheckedChange={value=>change([tool.name],value===true)}/>:undefined}/>)}</ul>
    </CollapsibleContent>
  </Collapsible>;
}
