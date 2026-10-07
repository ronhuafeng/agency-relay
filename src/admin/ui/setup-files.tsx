import { FileCode, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/tabs";
import { Button } from "./components/button";
import { useEnhanced } from "./use-enhanced";
export interface SetupFileTarget { readonly client: string; readonly clientLabel: string; readonly filename: string; readonly installTarget: string; readonly template?: string }
export interface SetupFilesControl { readonly id: string; readonly files: readonly SetupFileTarget[]; readonly clientSelectId?: string }
export function readSetupFiles(value: unknown): SetupFilesControl | null {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !("files" in value) || !Array.isArray(value.files)) return null;
  const files: SetupFileTarget[] = [];
  for (const file of value.files) {
    if (!file || typeof file !== "object" || typeof file.client !== "string" || typeof file.clientLabel !== "string" || typeof file.filename !== "string" || typeof file.installTarget !== "string") return null;
    if (file.template !== undefined && typeof file.template !== "string") return null;
    files.push({client:file.client,clientLabel:file.clientLabel,filename:file.filename,installTarget:file.installTarget,template:file.template});
  }
  if ("clientSelectId" in value && value.clientSelectId !== undefined && typeof value.clientSelectId !== "string") return null;
  return {id:value.id,files,clientSelectId:"clientSelectId" in value ? value.clientSelectId as string|undefined : undefined};
}
export function SetupTemplate({file}: {readonly file: SetupFileTarget}) {
  return file.template ? <figure className="setup-template"><figcaption>配置模板 · 密钥为占位符</figcaption><pre tabIndex={0}>{file.template}</pre></figure> : null;
}
export function SetupFileTargetView({file, enhanced, showTemplate = true}: {readonly file: SetupFileTarget; readonly enhanced: boolean; readonly showTemplate?: boolean}) {
  const [copyState,setCopyState] = useState<"idle"|"copied"|"failed">("idle");
  const copyPath = async (): Promise<void> => {
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(file.installTarget); setCopyState("copied");
    } catch { setCopyState("failed"); }
  };
  return <section className="setup-file-target" data-setup-client={file.client}><div className="setup-file-title"><FileCode aria-hidden="true" className="ui-icon"/><div><h3>{file.filename}</h3><span>{file.clientLabel}</span></div></div><div className="setup-destination"><span>安装位置</span><div><code>{file.installTarget}</code>{enhanced ? <Button variant="ghost" size="icon" aria-label={`复制 ${file.clientLabel} 安装位置`} onClick={() => { void copyPath(); }}><Copy className="ui-icon" aria-hidden="true"/></Button> : null}</div></div>{showTemplate ? <SetupTemplate file={file}/> : null}{copyState !== "idle" ? <p className="meta" role="status">{copyState === "copied" ? "安装位置已复制" : "无法自动复制，请选择并复制路径。"}</p> : null}</section>;
}
export function SetupFilesView({control}: {readonly control: SetupFilesControl}) {
  const enhanced = useEnhanced();
  const [client,setClient] = useState(control.files[0]?.client);
  useEffect(() => {
    if (!control.clientSelectId) return;
    const select = document.getElementById(control.clientSelectId);
    if (!(select instanceof HTMLSelectElement)) return;
    const update = () => setClient(select.value);
    update(); select.addEventListener("change",update); select.form?.addEventListener("console:restore",update);
    return () => {select.removeEventListener("change",update); select.form?.removeEventListener("console:restore",update);};
  },[control.clientSelectId]);
  if (!enhanced) return <div className="setup-client-files">{control.files.map(file=><SetupFileTargetView key={file.client} file={file} enhanced={false}/>)}</div>;
  if (control.clientSelectId) {
    const file = control.files.find(file=>file.client===client);
    return <div className="setup-client-files">{file ? <SetupFileTargetView key={file.client} file={file} enhanced/> : null}</div>;
  }
  if (control.files.length === 1) return <div className="setup-client-files"><SetupFileTargetView file={control.files[0]!} enhanced/></div>;
  return <Tabs defaultValue={control.files[0]?.client} className="setup-client-files"><TabsList variant="line" aria-label="客户端配置">{control.files.map(file=><TabsTrigger key={file.client} value={file.client}>{file.clientLabel}</TabsTrigger>)}</TabsList>{control.files.map(file=><TabsContent key={file.client} value={file.client}><SetupFileTargetView file={file} enhanced/></TabsContent>)}</Tabs>;
}
