import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ConfigurationHelp } from "../../src/admin/ui/task-help";
import { SetupFilesIsland } from "../../src/admin/ui/islands";
import { buildClientSetupFiles, CLIENT_SETUP_TOKEN_PLACEHOLDER, PRODUCT_ACCESS } from "../../src/admin/client-setup";

describe("contextual task help", () => {
  it("shows shared destinations and placeholder templates without publishing held-key file contents", () => {
    const doc = new JSDOM(renderToStaticMarkup(createElement(ConfigurationHelp))).window.document;
    const files = buildClientSetupFiles({token: CLIENT_SETUP_TOKEN_PLACEHOLDER, scopes: Object.values(PRODUCT_ACCESS).map(item => item.grant)});
    expect(doc.querySelectorAll('[data-setup-client]')).toHaveLength(files.length);
    for (const file of files) {
      const detail = doc.querySelector(`[data-setup-client="${file.client}"]`)!;
      expect(detail.querySelector('h3')?.textContent).toBe(file.filename);
      expect(detail.querySelector('code')?.textContent).toBe(file.installTarget);
      const template = detail.querySelector('figure.setup-template');
      expect(template?.querySelector('figcaption')?.textContent).toBe('配置模板 · 密钥为占位符');
      expect(template?.querySelector('pre')?.textContent).toContain(CLIENT_SETUP_TOKEN_PLACEHOLDER);
      expect(template?.querySelector('pre')?.getAttribute('tabindex')).toBe('0');
      expect(template?.querySelector('pre')?.hasAttribute('aria-label')).toBe(false);
    }
    expect(doc.querySelectorAll('form,input,details')).toHaveLength(0);
    const serialized = JSON.parse(doc.querySelector('script[type="application/json"]')!.textContent!);
    expect(serialized.files.map(({template,...target}: {template:string})=>target)).toEqual(files.map(({client,clientLabel,filename,installTarget})=>({client,clientLabel,filename,installTarget})));
    const heldKeyFiles=buildClientSetupFiles({token:'private-file-content',scopes:[PRODUCT_ACCESS.codex.grant]});
    const metadata=renderToStaticMarkup(createElement(SetupFilesIsland,{control:{id:'held-file-target',files:heldKeyFiles}}));
    expect(metadata).not.toContain('private-file-content');
    expect(doc.querySelector('a[href*="github.com"]')).toBeNull();
  });
  it.each([null, {id: "service / exact", display_name: "Build", status: "active"}])("keeps help recovery links in the current ownership context (%j)", service => {
    const prefix = service ? '/me/service-accounts/service%20%2F%20exact?view=' : '/admin?area=me&view=';
    const href = (view: "keys" | "setup" | "quota") => prefix + view;
    const html = renderToStaticMarkup(createElement(ConfigurationHelp, {recoveryHref:href}));
    const doc = new JSDOM(html).window.document;
    const popup = doc.querySelector('[popover]')!;
    expect([...popup.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual([prefix+'keys', prefix+'quota']);
    expect(doc.querySelectorAll('[data-task-help]')).toHaveLength(1);
    expect(doc.querySelectorAll('[popover]')).toHaveLength(1);
    expect(popup.getAttribute('aria-label')).toBe('配置说明');
    expect(popup.textContent).toContain('先备份原配置');
    expect(popup.textContent).toContain('读取失败表示未知');
    for (const popup of doc.querySelectorAll('[popover]')) expect(doc.querySelector(`button[popovertarget="${popup.id}"]`)).not.toBeNull();
    expect(doc.querySelector('form,input')).toBeNull();
  });
});
