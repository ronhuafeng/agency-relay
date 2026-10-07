import { describe, expect, it } from "vitest";
import { ISSUABLE_SURFACE_GRANTS, listExecutionPlans } from "../../src/plans/execution-plans";
import { projectSurfaceCapabilityView } from "../../src/plans/capabilities";

describe("surface capability catalog", () => {
  it("projects the three access cards from one product catalog", () => {
    const view = projectSurfaceCapabilityView(listExecutionPlans());

    expect(view.surfaces.map((surface) => ({
      id: surface.id,
      label: surface.label,
      accessLevel: surface.accessLevel,
      badge: surface.badge,
      summary: surface.summaryCapabilities,
      authority: [surface.authorityLabel, surface.authorityNote]
    }))).toEqual([
      {
        id: "codex",
        label: "Codex",
        accessLevel: "everyday",
        badge: "编程代理",
        summary: ["编写、审查与自动化", "工作区工具", "长时间编程"],
        authority: [
          "已连接的 ChatGPT",
          "由已连接的 ChatGPT 订阅支持的完整编程客户端。"
        ]
      },
      {
        id: "grok",
        label: "Grok",
        accessLevel: "everyday",
        badge: "编程与媒体",
        summary: [
          "Grok 对话与编程",
          "语音与转写",
          "图像与视频",
          "文件、模型与分词"
        ],
        authority: [
          "已连接的 Grok",
          "包含 Grok Build，以及有限的 xAI 能力。文件和视频仍绑定账号所有者。"
        ]
      },
      {
        id: "xai",
        label: "xAI API",
        accessLevel: "selected",
        badge: "指定访问",
        summary: [
          "文本、模型响应与实时",
          "图像、视频与语音",
          "文件、搜索与批处理",
          "模型、音色与分词"
        ],
        authority: [
          "指定访问",
          "可以操作组织共享的 xAI API 资源。只授予值得信任的人员。"
        ]
      }
    ]);
  });

  it("classifies every product plan once into an honest capability comparison", () => {
    const plans = listExecutionPlans();
    const view = projectSurfaceCapabilityView(plans);
    const rows = new Map(view.groups.flatMap((group) => group.rows).map((row) => [row.id, row]));
    const classifiedPlanIds = view.groups
      .flatMap((group) => group.rows)
      .flatMap((row) => Object.values(row.cells))
      .flatMap((cell) => cell.routes)
      .map((route) => route.sourcePlanId);

    expect(view.groups.map((group) => group.label)).toEqual([
      "构建与推理",
      "创建媒体",
      "语音",
      "处理数据",
      "实时与高级"
    ]);
    expect(classifiedPlanIds.sort()).toEqual(plans.map((plan) => plan.id).sort());
    expect(new Set(classifiedPlanIds).size).toBe(plans.length);
    expect(view.groups.flatMap((group) => group.rows).flatMap((row) =>
      Object.values(row.cells).flatMap((cell) => cell.routes)
    ).every((route) => !/[\^$\[\]]/.test(route.path))).toBe(true);

    expect(rows.get("context_compaction")?.cells).toMatchObject({
      codex: { state: "included", label: "远程" },
      grok: { state: "in_client", label: "在 Grok Build 中" },
      xai: { state: "team_access", label: "远程" }
    });
    expect(rows.get("video")?.cells).toMatchObject({
      codex: { state: "not_available" },
      grok: { state: "owner_bound" },
      xai: { state: "team_access" }
    });
    expect(rows.get("files_core")?.cells).toMatchObject({
      codex: { state: "not_available" },
      grok: { state: "owner_bound" },
      xai: { state: "team_access" }
    });
    expect(rows.get("custom_voices")?.cells.xai).toMatchObject({
      state: "list_only",
      label: "仅列出"
    });
    expect(rows.get("responses_websocket")?.cells).toMatchObject({
      codex: { state: "upgrade_required", label: "需要升级" },
      grok: { state: "not_available" },
      xai: { state: "team_access", label: "已包含" }
    });
    expect(view.surfaces.map((surface) => surface.grant).sort()).toEqual(
      [...ISSUABLE_SURFACE_GRANTS].sort()
    );
  });

  it("fails closed when runtime plans and the product catalog drift", () => {
    const plans = listExecutionPlans();
    const extraPlan = { ...plans[0]!, id: "codex.future_unclassified" };
    expect(() => projectSurfaceCapabilityView([...plans, extraPlan])).toThrow(
      "Surface capability catalog does not classify: codex.future_unclassified"
    );

    expect(() => projectSurfaceCapabilityView(
      plans.filter((plan) => plan.id !== "xai.production.documents_search")
    )).toThrow(
      "Surface capability catalog references missing plan: xai.production.documents_search"
    );
  });
});
