import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "./components/badge";
import { Button } from "./components/button";
import { Card } from "./components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/tabs";
import { ConfirmationFallback, Field, KeyExpiryField } from "./fields";
import { SelectView } from "./forms";
import { DashLink } from "./chrome";
import { TaskClose } from "./task-workspace";
import { SetupFileTargetView, SetupTemplate, readSetupFiles, type SetupFileTarget } from "./setup-files";
import { ConfigurationInstructions } from "./task-help";
import { useEnhanced } from "./use-enhanced";

interface SetupVerification {
  readonly client: string;
  readonly result: "works" | "failed" | "not-verified";
  readonly text: string;
}
export interface SetupWorkbenchKey {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly prefix: string;
  readonly state: string;
  readonly status: string;
  readonly files: readonly SetupFileTarget[];
  readonly verifications: readonly SetupVerification[];
  readonly manageHref: string;
  readonly closeHref: string;
  readonly heldHref: string;
  readonly selectedHref: string;
  readonly newKeyHref?: string;
  readonly hideTemplates?: boolean;
  readonly replacement?: { readonly action: string; readonly returnHref: string; readonly confirmation: string };
}
export interface SetupWorkbenchControl {
  readonly id: string;
  readonly localFiles: readonly SetupFileTarget[];
  readonly selected?: SetupWorkbenchKey;
  readonly initialMode?: "held";
  readonly recovery?: { readonly keys: string; readonly quota: string };
}

export function readSetupWorkbench(value: unknown): SetupWorkbenchControl | null {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !("localFiles" in value)) return null;
  const local = readSetupFiles({id:value.id,files:value.localFiles});
  if (!local || ("initialMode" in value && value.initialMode !== undefined && value.initialMode !== "held")) return null;
  let selected: SetupWorkbenchKey | undefined;
  if ("selected" in value && value.selected !== undefined) {
    const key = value.selected;
    if (!key || typeof key !== "object" || !["id","owner","name","prefix","state","status","manageHref","closeHref","heldHref","selectedHref"].every(name => name in key && typeof key[name as keyof typeof key] === "string") || !("files" in key) || !("verifications" in key) || !Array.isArray(key.verifications)) return null;
    const files = readSetupFiles({id:value.id,files:key.files});
    if (!files || key.verifications.some(row => !row || typeof row.client !== "string" || typeof row.text !== "string" || !["works","failed","not-verified"].includes(row.result))) return null;
    if ("replacement" in key && key.replacement !== undefined) {
      const replacement = key.replacement;
      if (!replacement || typeof replacement !== "object" || !["action","returnHref","confirmation"].every(name => name in replacement && typeof replacement[name as keyof typeof replacement] === "string")) return null;
    }
    if ("newKeyHref" in key && key.newKeyHref !== undefined && typeof key.newKeyHref !== "string") return null;
    if ("hideTemplates" in key && key.hideTemplates !== undefined && typeof key.hideTemplates !== "boolean") return null;
    selected = {...key,files:files.files} as SetupWorkbenchKey;
  }
  let recovery: SetupWorkbenchControl["recovery"];
  if ("recovery" in value && value.recovery !== undefined) {
    const links = value.recovery;
    if (!links || typeof links !== "object" || !("keys" in links) || typeof links.keys !== "string" || !("quota" in links) || typeof links.quota !== "string") return null;
    recovery = {keys:links.keys,quota:links.quota};
  }
  return {id:value.id,localFiles:local.files,selected,initialMode:"initialMode" in value ? value.initialMode as "held" | undefined : undefined,recovery};
}

/** One client choice owns the destination, public template and local download. */
export function SetupWorkbenchView({control}: {readonly control: SetupWorkbenchControl}) {
  const enhanced = useEnhanced();
  const key = control.selected;
  const [mode,setMode] = useState<"selected" | "held">(key && control.initialMode !== "held" ? "selected" : "held");
  const initialFiles = key && control.initialMode !== "held" ? key.files : control.localFiles;
  const [client,setClient] = useState(initialFiles[0]?.client ?? "codex");
  const [discardFocus,setDiscardFocus] = useState<string | null>(null);
  const localForm = useRef<HTMLFormElement | null>(null);
  const clientTabs = useRef<HTMLDivElement | null>(null);
  const restoredClient = useRef(false);
  const files = mode === "selected" && key ? key.files : control.localFiles;
  const activeFile = files.find(file => file.client === client) ?? files[0];
  useLayoutEffect(() => {
    if (discardFocus === null || activeFile?.client !== discardFocus) return;
    if (clientTabs.current?.isConnected) clientTabs.current.querySelector<HTMLButtonElement>('[data-slot="tabs-trigger"][data-state="active"]')?.focus();
    setDiscardFocus(null);
  },[activeFile?.client,discardFocus]);
  const chooseClient = (next: string): void => {
    setDiscardFocus(null);
    setClient(next);
    const select = localForm.current?.elements.namedItem("client");
    if (select instanceof HTMLSelectElement) {
      select.value = next;
      select.dispatchEvent(new Event("change",{bubbles:true}));
    }
  };
  useEffect(() => {
    const form = localForm.current;
    if (!form) return;
    const restore = (): void => {
      const select = form.elements.namedItem("client");
      if (select instanceof HTMLSelectElement) {
        restoredClient.current = true;
        if (mode === "held") setClient(select.value);
      }
    };
    const discard = (): void => {
      const select = form.elements.namedItem("client");
      if (select instanceof HTMLSelectElement) setDiscardFocus(select.value);
    };
    form.addEventListener("console:restore",restore); form.addEventListener("console:discard",discard);
    return () => {form.removeEventListener("console:restore",restore); form.removeEventListener("console:discard",discard);};
  },[mode]);
  const chooseMode = (next: "selected" | "held"): void => {
    const nextFiles = next === "selected" && key ? key.files : control.localFiles;
    const select = localForm.current?.elements.namedItem("client");
    const preferred = next === "held" && restoredClient.current && select instanceof HTMLSelectElement ? select.value : client;
    chooseClient(nextFiles.find(file=>file.client===preferred)?.client ?? nextFiles[0]?.client ?? "codex");
    setMode(next);
  };
  const content = <div className="setup-workbench-body" data-task-help="configuration">
    {enhanced ? activeFile ? <SetupFileTargetView key={activeFile.client} file={activeFile} enhanced showTemplate={false}/> : <p className="empty">这个密钥没有客户端访问。</p> : files.map(file=><SetupFileTargetView key={file.client} file={file} enhanced={false} showTemplate={!key?.hideTemplates}/>)}
    {key ? <div className="setup-mode-choices" role="group" aria-label="配置方式">{enhanced ? <><Button type="button" variant={mode === "selected" ? "secondary" : "outline"} aria-pressed={mode === "selected"} onClick={()=>chooseMode("selected")}>{key.replacement ? "换发密钥" : "所选密钥"}</Button><Button type="button" variant={mode === "held" ? "secondary" : "outline"} aria-pressed={mode === "held"} onClick={()=>chooseMode("held")}>已有密钥</Button></> : <><DashLink className="action-link" href={key.selectedHref}>{key.replacement ? "换发密钥" : "所选密钥"}</DashLink><DashLink className="action-link" href={key.heldHref}>用已有密钥生成配置</DashLink></>}</div> : null}
    {key ? <div className="setup-selected-action" hidden={mode !== "selected"}>
      {key.replacement ? <><p className="caption">换发会创建新密钥，不会自动撤销原密钥。配置包只包含此密钥获准使用的客户端。</p><form className="board-form" method="post" action={key.replacement.action} data-action="create-setup-package" data-dashboard-draft="replacement" data-draft-scope="setup" data-confirmation={key.replacement.confirmation}>
        <ConfirmationFallback message={key.replacement.confirmation}/><input type="hidden" name="confirm" value="1"/><input type="hidden" name="key_return" value={key.replacement.returnHref}/><KeyExpiryField/>
        <div className="form-footer"><Button type="submit">换发密钥并下载配置包</Button><DashLink className="action-link" href={key.manageHref}>管理密钥</DashLink></div>
      </form></> : key.newKeyHref ? <DashLink className="action-link" href={key.newKeyHref}>创建新密钥</DashLink> : <p className="caption">旧密钥无法重新显示明文。持有完整密钥时，可切换到“已有密钥”生成配置文件。</p>}
      {!key.replacement ? <DashLink className="action-link" href={key.manageHref}>管理密钥</DashLink> : null}
    </div> : null}
    <form ref={localForm} className="board-form setup-held-form" data-local-config-sync="true" data-workbench-local="" data-dashboard-draft="sync" hidden={!enhanced || mode !== "held"}>
      <div hidden={enhanced}><SelectView control={{id:"select-sync-client",name:"client",label:"客户端",required:true,value:control.localFiles[0]?.client ?? "codex",options:control.localFiles.map(file=>({value:file.client,label:file.clientLabel,disabled:false}))}} onValueChange={setClient}/></div>
      <Field control={{label:"已有密钥",name:"existing_key",type:"password",autoComplete:"off",pattern:"cfwd_[A-Za-z0-9_-]+",required:true}}/>
      <p className="caption">密钥仅用于本机生成文件；不会上传，也不会验证服务权限或连接状态。</p>
      <div className="form-footer"><Button type="submit">下载配置文件</Button></div>
    </form>
    <noscript><p className="caption">要在这台设备上生成文件，请启用 JavaScript。</p></noscript>
    {enhanced && activeFile?.template && !(mode === "selected" && key?.hideTemplates) ? <details className="setup-template-disclosure"><summary>查看配置模板</summary><SetupTemplate file={activeFile}/></details> : null}
    <footer className="setup-workbench-footer">
      {key && mode === "selected" ? <section className="setup-verification" aria-label="所选密钥的任务记录"><h3>所选密钥的任务记录</h3>{key.verifications.filter(row=>!enhanced || row.client===activeFile?.client).map(row=><p key={row.client} data-client-verification={row.client} data-result={row.result}><strong>{files.find(file=>file.client===row.client)?.clientLabel}</strong><Badge data-tone={row.result==="works"?"ok":row.result==="failed"?"bad":undefined}>{row.text}</Badge></p>)}</section> : <span className="caption">本机生成配置</span>}
      <ConfigurationInstructions recoveryHref={control.recovery ? view=>control.recovery![view] : undefined}/>
    </footer>
  </div>;
  return <Card className="setup-config-card setup-workbench" id="sync-configuration" tabIndex={-1} data-setup-selected-key={key?.id} data-sync-configuration={!key || mode === "held" ? "local-only" : undefined} data-configuration-mode={mode}>
    {key ? <header className="setup-workbench-key"><div><strong>{key.owner}</strong><span>{key.name} · <code>{key.prefix}</code></span></div><div className="task-head-actions"><Badge className="key-state" data-key-state={key.state}>{key.status}</Badge><TaskClose href={key.closeHref} label="收起密钥配置"/></div></header> : null}
    <Tabs ref={clientTabs} value={activeFile?.client ?? "codex"} onValueChange={chooseClient} className="setup-workbench-clients"><TabsList variant="line" aria-label="客户端配置" hidden={!enhanced}>{files.map(file=><TabsTrigger key={file.client} value={file.client}>{file.clientLabel}</TabsTrigger>)}</TabsList><TabsContent value={activeFile?.client ?? "codex"}>{content}</TabsContent></Tabs>
  </Card>;
}
