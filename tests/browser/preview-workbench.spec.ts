import { readFileSync } from "node:fs";
import { test, expect, type Route } from "@playwright/test";

const workbench = readFileSync("scripts/console-preview/workbench.html", "utf8");

// Exercise unchanged workbench source against an auth-free frame endpoint.
// A fresh visible document must replace an explicit refresh; resize must retain
// its draft. JSDOM does not implement the fragment-navigation/reload distinction.
test("refreshes the selected object after overlapping theme changes and a failed configuration", async ({page}) => {
  let revision = "original";
  let holdDark = false;
  let failSystem = false;
  let held: Route | undefined;
  const configurations: string[] = [];
  const unexpected: string[] = [];
  const object = "/?view=credentials&range=7d&account=codex%3Asynthetic&q=team#account-detail";
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://preview.test") {unexpected.push(url.origin); await route.abort(); return;}
    if (url.pathname === "/__preview") return route.fulfill({contentType:"text/html",body:workbench});
    if (url.pathname === "/__preview/data") return route.fulfill({json:{snapshot:false}});
    if (url.pathname === "/__preview/revision") return route.fulfill({body:revision});
    if (url.pathname === "/__preview/config") {
      const theme = route.request().postDataJSON().theme;
      configurations.push(theme);
      if (holdDark && theme === "dark") {held = route; return;}
      return route.fulfill({status:failSystem && theme === "system" ? 503 : 200,body:""});
    }
    if (url.pathname === "/") return route.fulfill({contentType:"text/html",body:`<!doctype html><html><body><a href="${object}">Open account</a><p>${revision}</p><label>Draft<input></label></body></html>`});
    unexpected.push(url.pathname); await route.abort();
  });
  try {
    await page.goto("http://preview.test/__preview?role=admin&scene=populated&page=quotas&width=768&theme=light");
    const frame = page.frameLocator("#preview");
    await expect(page.getByRole("status")).toContainText("已加载");
    await frame.getByRole("link",{name:"Open account"}).click();
    await expect(page.getByRole("link",{name:"独立打开"})).toHaveAttribute("href",`http://preview.test${object}`);
    await frame.getByLabel("Draft").fill("unfinished label");
    await page.getByRole("button",{name:"手机 390 像素"}).click();
    await expect(frame.getByLabel("Draft")).toHaveValue("unfinished label");
    expect(configurations).toEqual(["light"]);

    revision = "refreshed";
    await page.getByRole("button",{name:"刷新页面"}).click();
    await expect(frame.getByText("refreshed",{exact:true})).toBeVisible();
    await expect(page.getByRole("status")).toContainText("已加载");
    await expect(page.getByRole("link",{name:"独立打开"})).toHaveAttribute("href",`http://preview.test${object}`);

    holdDark = true; failSystem = true;
    await page.getByRole("radio",{name:"深色",exact:true}).check();
    await expect.poll(()=>Boolean(held)).toBe(true);
    await page.getByRole("radio",{name:"系统",exact:true}).check();
    await held!.fulfill({status:200,body:""}); held = undefined;
    await expect(page.getByRole("status")).toContainText("加载失败");
    await expect(frame.getByText("refreshed",{exact:true})).toBeVisible();
    revision = "recovered"; failSystem = false;
    await page.getByRole("button",{name:"刷新页面"}).click();
    await expect(frame.getByText("recovered",{exact:true})).toBeVisible();
    await expect(page.getByRole("status")).toContainText("已加载");
    await expect(page.getByRole("radio",{name:"系统",exact:true})).toBeChecked();
    await expect(page.getByRole("link",{name:"独立打开"})).toHaveAttribute("href",`http://preview.test${object}`);
    expect(configurations).toEqual(["light","light","dark","system","system"]);
    expect(unexpected).toEqual([]);
  } finally {
    if (held) await held.abort();
    await page.unrouteAll({behavior:"wait"});
  }
});
