import { buildClientSetupFiles, CLIENT_SETUP_TOKEN_PLACEHOLDER, PRODUCT_ACCESS } from "../client-setup";
import { SetupFilesIsland } from "./islands";
import { InfoPopover } from "./components/info-popover";
import type { SetupFileTarget } from "./setup-files";

/** Public previews always use the placeholder, never newly issued or user input keys. */
export function configurationTargets(scopes: readonly string[]): SetupFileTarget[] {
  return buildClientSetupFiles({token:CLIENT_SETUP_TOKEN_PLACEHOLDER,scopes}).map(({client,clientLabel,filename,installTarget,content})=>({
    client,clientLabel,filename,installTarget,template:content.split("\n").filter(line=>!line.startsWith("#")).join("\n").trim()
  }));
}

/** Contextual help consumes the same templates as downloads; no second setup format. */
export interface ConfigurationHelpProps {
  readonly recoveryHref?: (view: "keys" | "quota") => string;
}
export function ConfigurationInstructions({recoveryHref}: ConfigurationHelpProps) {
  return <InfoPopover id="configuration-install-help" label="配置说明" iconOnly>
    <p>先备份原配置，再合并下载文件中的选项。保留已有的模型、MCP 和用户设置。生成或下载文件不表示客户端已登录、获得服务权限或完成真实任务。</p>
    {recoveryHref ? <><h3>遇到问题</h3><ul>
      <li>先区分登录状态、服务资格、余额、密钥到期/撤销、绑定条件和真实任务结果。不要只凭一个状态码猜原因；读取失败表示未知，不表示没有密钥或额度为零。</li>
      <li>创建条件或默认设置不满足时，查看页面给出的原因并联系管理员。不要自行选择内部凭据；已有密钥仍可按自己的状态查看或撤销。</li>
      <li>复制失败可全选后手动复制。选中不代表已复制成功，需在自己的目标客户端确认；不要粘到反馈文字、聊天或 issue。</li>
      <li>提交后停止等待、断网或结果未确认时，先用页面的只读恢复入口核对当前对象，勿重复创建、更换或撤销。已确认成功但刷新失败时，保留成功事实，再读取当前状态。</li>
      <li>仍无法完成真实任务时，可向管理员提供请求 ID、发生时间和客户端名称；不要附完整密钥、配置、提示词或响应内容。管理员只能根据已保存的活动证据诊断，无记录不能证明请求未执行。</li>
    </ul>
    <p><a className="action-link" href={recoveryHref("keys")}>只读查看本账号的密钥</a> · <a className="action-link" href={recoveryHref("quota")}>查看本账号的额度</a></p></> : null}
  </InfoPopover>;
}
export function ConfigurationHelp({recoveryHref}: ConfigurationHelpProps) {
  const examples = configurationTargets(Object.values(PRODUCT_ACCESS).map(item => item.grant));
  return <section data-task-help="configuration" className="configuration-targets"><SetupFilesIsland control={{id:"local-config-files",files:examples,clientSelectId:"select-sync-client"}}/><ConfigurationInstructions recoveryHref={recoveryHref}/></section>;
}
