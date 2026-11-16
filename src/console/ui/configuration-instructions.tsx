import { InfoPopover } from "./components/info-popover";

/** Install and recovery guidance only. It is hydrated in the browser, so it must not import
 * the setup-template builder or the plan catalogue behind it; those stay on the server. */
export interface ConfigurationHelpProps {
  readonly recoveryHref?: (view: "keys" | "quota") => string;
}
export function ConfigurationInstructions({recoveryHref}: ConfigurationHelpProps) {
  return <InfoPopover id="configuration-install-help" label="安装与排错" iconOnly>
    <ol><li>备份原配置，再把下载文件中的选项合并到所示安装位置。保留已有的模型、MCP 和用户设置。</li><li>启动客户端并发送一次请求，检查是否可用。下载成功只表示文件已生成。</li></ol>
    {recoveryHref ? <><h3>无法连接？</h3><p>查看密钥是否有效、服务是否可用，以及剩余额度。状态无法读取时，重新加载后再判断。</p>
    <p><a className="action-link" href={recoveryHref("keys")}>查看密钥</a> · <a className="action-link" href={recoveryHref("quota")}>查看额度</a></p>
    <p>仍有问题时，向管理员提供请求 ID、时间和客户端名称。不要附密钥、完整配置、提示词或响应内容。</p></> : null}
  </InfoPopover>;
}
