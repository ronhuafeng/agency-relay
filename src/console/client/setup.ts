interface Template { client: string; filename: string; content: string }
interface SetupConfig { templates: Template[]; placeholder: string }
function readConfig(text: string): SetupConfig | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || !("placeholder" in value) || typeof value.placeholder !== "string" || value.placeholder === "" || !("templates" in value) || !Array.isArray(value.templates)) return null;
    const templates: Template[] = [];
    for (const item of value.templates) {
      if (typeof item !== "object" || item === null || !("client" in item) || !("filename" in item) || !("content" in item) || typeof item.client !== "string" || typeof item.filename !== "string" || typeof item.content !== "string") return null;
      templates.push({ client: item.client, filename: item.filename, content: item.content });
    }
    return { templates, placeholder: value.placeholder };
  } catch { return null; }
}
export function initializeSetup(): void {
  const config = readConfig(document.getElementById("console-setup-config")?.textContent ?? ""); if (!config) return;
  document.addEventListener("submit", (event) => {
    const form = event.target; if (!(form instanceof HTMLFormElement) || !form.matches('[data-local-config-sync="true"]')) return;
    event.preventDefault();
    let feedback = form.querySelector<HTMLElement>("[data-setup-feedback]");
    if (!feedback) { feedback = document.createElement("p"); feedback.dataset.setupFeedback = ""; feedback.className = "setup-feedback"; feedback.setAttribute("role", "status"); form.append(feedback); }
    const data = new FormData(form); const rawToken = data.get("existing_key"); const client = data.get("client");
    const token = typeof rawToken === "string" ? rawToken.trim() : ""; const template = config.templates.find((item) => item.client === client);
    if (!/^cfwd_[A-Za-z0-9_-]+$/.test(token) || !template) { feedback.textContent = "请粘贴完整的 Agency Relay 密钥，并选择客户端。"; return; }
    const content = template.content.split(config.placeholder).join(token); const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = template.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    feedback.textContent = `已生成 ${template.filename}。请保存文件；生成文件不代表密钥已通过验证。`;
  });
}
export function initializeView(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[data-local-config-sync]:not([data-workbench-local])").forEach((form) => { form.hidden = false; });
}
