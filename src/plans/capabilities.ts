import { PRODUCT_ACCESS, type ProductAccessId } from "../admin/client-setup";
import {
  publicExecutionPlanPath,
  type ExecutionPlan,
  type PlanSupportStatus
} from "./execution-plans";

export interface SurfaceCapabilitySurface {
  id: ProductAccessId;
  label: string;
  grant: string;
  accessLevel: "everyday" | "selected";
  badge: string;
  promise: string;
  summaryCapabilities: readonly string[];
  authorityLabel: string;
  authorityNote: string;
}

export type SurfaceCapabilityState =
  | "included"
  | "owner_bound"
  | "team_access"
  | "in_client"
  | "api_building_blocks"
  | "list_only"
  | "upgrade_required"
  | "not_available";

export interface SurfaceCapabilityRoute {
  sourcePlanId: string;
  hostname: string;
  method: ExecutionPlan["method"];
  path: string;
  transport: "http" | "websocket";
  supportStatus: PlanSupportStatus;
}

export interface SurfaceCapabilityCell {
  state: SurfaceCapabilityState;
  label: string;
  detail?: string;
  routes: readonly SurfaceCapabilityRoute[];
}

export interface SurfaceCapabilityRow {
  id: string;
  label: string;
  description: string;
  cells: Record<ProductAccessId, SurfaceCapabilityCell>;
}

export interface SurfaceCapabilityGroup {
  id: string;
  label: string;
  rows: readonly SurfaceCapabilityRow[];
}

export interface SurfaceCapabilityView {
  surfaces: readonly SurfaceCapabilitySurface[];
  groups: readonly SurfaceCapabilityGroup[];
}

interface CapabilityCellDefinition {
  state: SurfaceCapabilityState;
  label: string;
  detail?: string;
  planIds?: readonly string[];
}

interface CapabilityRowDefinition {
  id: string;
  label: string;
  description: string;
  cells: Record<ProductAccessId, CapabilityCellDefinition>;
}

interface CapabilityGroupDefinition {
  id: string;
  label: string;
  rows: readonly CapabilityRowDefinition[];
}

const SURFACES: readonly SurfaceCapabilitySurface[] = [
  {
    ...PRODUCT_ACCESS.codex,
    accessLevel: "everyday",
    badge: "编程代理",
    promise: "连接工作区的 OpenAI 编程代理。",
    summaryCapabilities: ["编写、审查与自动化", "工作区工具", "长时间编程"],
    authorityLabel: "已连接的 ChatGPT",
    authorityNote: "由已连接的 ChatGPT 订阅支持的完整编程客户端。"
  },
  {
    ...PRODUCT_ACCESS.grok,
    accessLevel: "everyday",
    badge: "编程与媒体",
    promise: "通过同一项访问使用 Grok Build 和 xAI 创作工具。",
    summaryCapabilities: [
      "Grok 对话与编程",
      "语音与转写",
      "图像与视频",
      "文件、模型与分词"
    ],
    authorityLabel: "已连接的 Grok",
    authorityNote: "包含 Grok Build，以及有限的 xAI 能力。文件和视频仍绑定账号所有者。"
  },
  {
    ...PRODUCT_ACCESS.xai,
    accessLevel: "selected",
    badge: "指定访问",
    promise: "向明确获批的人员提供较完整的 xAI API。",
    summaryCapabilities: [
      "文本、模型响应与实时",
      "图像、视频与语音",
      "文件、搜索与批处理",
      "模型、音色与分词"
    ],
    authorityLabel: "指定访问",
    authorityNote: "可以操作组织共享的 xAI API 资源。只授予值得信任的人员。"
  }
];

const unavailable = (): CapabilityCellDefinition => ({
  state: "not_available",
  label: "不可用"
});

const capability = (
  state: SurfaceCapabilityState,
  label: string,
  planIds: readonly string[] = [],
  detail?: string
): CapabilityCellDefinition => ({ state, label, planIds, ...(detail ? { detail } : {}) });

const GROUP_DEFINITIONS: readonly CapabilityGroupDefinition[] = [
  {
    id: "build_reason",
    label: "构建与推理",
    rows: [
      {
        id: "coding_client",
        label: "完整的编程客户端",
        description: "可直接使用的编程客户端，不是原始的服务商调用。",
        cells: {
          codex: capability("included", "Codex CLI"),
          grok: capability("included", "Grok Build"),
          xai: capability("api_building_blocks", "API 构件")
        }
      },
      {
        id: "responses",
        label: "模型响应",
        description: "按该服务自己的协议创建模型响应。",
        cells: {
          codex: capability("included", "已包含", ["codex.responses"]),
          grok: capability("included", "Grok CLI 协议", ["grok.production.responses"]),
          xai: capability("team_access", "xAI 协议", ["xai.production.responses"])
        }
      },
      {
        id: "context_compaction",
        label: "上下文压缩",
        description: "让长对话保持可用，不发明跨服务商的格式。",
        cells: {
          codex: capability("included", "远程", ["codex.responses_compact"]),
          grok: capability("in_client", "在 Grok Build 中", [], "这是客户端本地行为。Agency Relay 不提供压缩接口。"),
          xai: capability("team_access", "远程", ["xai.production.responses_compact"])
        }
      },
      {
        id: "chat_completions",
        label: "对话补全",
        description: "服务商的对话调用。支持的服务可以稍后取回延迟结果。",
        cells: {
          codex: unavailable(),
          grok: capability("included", "已包含", ["grok.production.chat_completions"]),
          xai: capability("team_access", "已包含", [
            "xai.production.chat_completions",
            "xai.production.chat_deferred_completion"
          ])
        }
      },
      {
        id: "stored_responses",
        label: "已保存的模型响应",
        description: "按标识读取或删除服务商保存的模型响应。",
        cells: {
          codex: unavailable(),
          grok: unavailable(),
          xai: capability("team_access", "读取与删除", [
            "xai.production.response",
            "xai.production.response_delete"
          ])
        }
      }
    ]
  },
  {
    id: "create_media",
    label: "创建媒体",
    rows: [
      {
        id: "image_generation",
        label: "图像生成",
        description: "按服务商支持的提示和选项生成图像。",
        cells: {
          codex: unavailable(),
          grok: capability("included", "已包含", ["grok.production.images_generations"]),
          xai: capability("team_access", "团队访问", ["xai.production.images_generations"])
        }
      },
      {
        id: "image_editing",
        label: "图像编辑",
        description: "按服务商的图像协议编辑图像。",
        cells: {
          codex: unavailable(),
          grok: capability("included", "已包含", ["grok.production.images_edits"]),
          xai: capability("team_access", "团队访问", ["xai.production.images_edits"])
        }
      },
      {
        id: "video",
        label: "视频创建与编辑",
        description: "生成、编辑、延长视频，并查询异步任务。",
        cells: {
          codex: unavailable(),
          grok: capability("owner_bound", "绑定所有者", [
            "grok.production.videos_generations",
            "grok.production.videos_edits",
            "grok.production.videos_extensions",
            "grok.production.videos_poll"
          ]),
          xai: capability("team_access", "团队访问", [
            "xai.production.videos_generations",
            "xai.production.videos_edits",
            "xai.production.videos_extensions",
            "xai.production.video"
          ])
        }
      }
    ]
  },
  {
    id: "speak_listen",
    label: "语音",
    rows: [
      {
        id: "text_to_speech",
        label: "文字转语音",
        description: "通过 HTTP 生成语音。支持的服务也可以使用 WebSocket。",
        cells: {
          codex: capability("included", "HTTP", ["codex.audio_speech"]),
          grok: capability("included", "HTTP", ["grok.production.tts"]),
          xai: capability("team_access", "HTTP 与 WebSocket", [
            "xai.production.tts",
            "xai.production.tts_websocket"
          ])
        }
      },
      {
        id: "speech_to_text",
        label: "语音转文字",
        description: "通过 HTTP 转写语音。支持的服务也可以使用 WebSocket。",
        cells: {
          codex: capability("included", "HTTP", ["codex.audio_transcriptions"]),
          grok: capability("included", "HTTP", ["grok.production.stt"]),
          xai: capability("team_access", "HTTP 与 WebSocket", [
            "xai.production.stt",
            "xai.production.stt_websocket"
          ])
        }
      },
      {
        id: "voice_catalog",
        label: "音色目录",
        description: "列出标准音色，并在支持时查看单个音色。",
        cells: {
          codex: unavailable(),
          grok: capability("included", "已包含", [
            "grok.production.tts_voices",
            "grok.production.tts_voice"
          ]),
          xai: capability("team_access", "团队访问", [
            "xai.production.tts_voices",
            "xai.production.tts_voice"
          ])
        }
      },
      {
        id: "custom_voices",
        label: "自定义音色",
        description: "查看自定义音色。这不表示可以修改它们。",
        cells: {
          codex: unavailable(),
          grok: unavailable(),
          xai: capability("list_only", "仅列出", ["xai.production.custom_voices"])
        }
      },
      {
        id: "realtime_voice",
        label: "实时会话",
        description: "与服务商建立双向实时会话。",
        cells: {
          codex: capability("included", "HTTP 与 WebSocket", [
            "codex.realtime_calls",
            "codex.live",
            "codex.realtime_websocket",
            "codex.live_websocket",
            "codex.live_call_websocket"
          ]),
          grok: unavailable(),
          xai: capability("team_access", "WebSocket", ["xai.production.realtime_websocket"])
        }
      }
    ]
  },
  {
    id: "work_data",
    label: "处理数据",
    rows: [
      {
        id: "model_catalogs",
        label: "模型目录与详情",
        description: "查看每个服务提供的模型。",
        cells: {
          codex: capability("included", "Codex 目录", ["codex.models"]),
          grok: capability("included", "Grok 与媒体目录", [
            "grok.production.models",
            "grok.production.language_models",
            "grok.production.language_model",
            "grok.production.image_generation_models",
            "grok.production.image_generation_model",
            "grok.production.video_generation_models",
            "grok.production.video_generation_model"
          ]),
          xai: capability("team_access", "xAI 目录", [
            "xai.production.models",
            "xai.production.model",
            "xai.production.language_models",
            "xai.production.language_model",
            "xai.production.image_generation_models",
            "xai.production.image_generation_model",
            "xai.production.video_generation_models",
            "xai.production.video_generation_model"
          ])
        }
      },
      {
        id: "tokenization",
        label: "文本分词",
        description: "按已接受的服务商协议，请 xAI 对文本分词。",
        cells: {
          codex: unavailable(),
          grok: capability("included", "已包含", ["grok.production.tokenize_text"]),
          xai: capability("team_access", "团队访问", ["xai.production.tokenize_text"])
        }
      },
      {
        id: "files_core",
        label: "文件上传、读取与删除",
        description: "在该服务的权限模型内创建和使用服务商文件。",
        cells: {
          codex: unavailable(),
          grok: capability("owner_bound", "绑定所有者", [
            "grok.production.files_upload",
            "grok.production.files_metadata",
            "grok.production.files_content",
            "grok.production.files_delete"
          ]),
          xai: capability("team_access", "团队访问", [
            "xai.production.files_upload",
            "xai.production.file",
            "xai.production.file_content",
            "xai.production.file_delete"
          ])
        }
      },
      {
        id: "files_team",
        label: "文件列表与公开链接",
        description: "列出共享文件，并管理临时公开链接。",
        cells: {
          codex: unavailable(),
          grok: unavailable(),
          xai: capability("team_access", "团队访问", [
            "xai.production.files_list",
            "xai.production.file_public_url",
            "xai.production.file_public_url_revoke"
          ])
        }
      },
      {
        id: "document_search",
        label: "文档搜索",
        description: "通过已接受的推理服务搜索服务商集合。",
        cells: {
          codex: unavailable(),
          grok: unavailable(),
          xai: capability("team_access", "团队访问", ["xai.production.documents_search"])
        }
      },
      {
        id: "batches",
        label: "批处理",
        description: "创建、查看、填充、收集和取消异步批处理。",
        cells: {
          codex: unavailable(),
          grok: unavailable(),
          xai: capability("team_access", "团队访问", [
            "xai.production.batches",
            "xai.production.batches_create",
            "xai.production.batch",
            "xai.production.batch_requests",
            "xai.production.batch_requests_add",
            "xai.production.batch_results",
            "xai.production.batch_cancel"
          ])
        }
      }
    ]
  },
  {
    id: "realtime_advanced",
    label: "实时与高级",
    rows: [
      {
        id: "responses_websocket",
        label: "模型响应长连接",
        description: "通过持久的双向连接流式传输模型响应。",
        cells: {
          codex: capability("upgrade_required", "需要升级", ["codex.responses_websocket"]),
          grok: unavailable(),
          xai: capability("team_access", "已包含", ["xai.production.responses_websocket"])
        }
      },
      {
        id: "ephemeral_credential",
        label: "临时访问凭证",
        description: "把短期访问凭证交给明确受信任的调用方。",
        cells: {
          codex: unavailable(),
          grok: unavailable(),
          xai: capability("team_access", "指定权限", ["xai.production.realtime_client_secrets"])
        }
      }
    ]
  }
];

export function projectSurfaceCapabilityView(
  plans: readonly ExecutionPlan[]
): SurfaceCapabilityView {
  const plansById = new Map(plans.map((plan) => [plan.id, plan]));
  if (plansById.size !== plans.length) {
    throw new Error("Surface capability catalog requires unique Execution Plan IDs");
  }

  const classifiedPlanIds = new Set<string>();
  const groups = GROUP_DEFINITIONS.map((group) => ({
    id: group.id,
    label: group.label,
    rows: group.rows.map((row) => {
      const projectCell = (surfaceId: ProductAccessId): SurfaceCapabilityCell => {
        const definition = row.cells[surfaceId];
        const routes = (definition.planIds ?? []).map((planId) => {
          const plan = plansById.get(planId);
          if (!plan) {
            throw new Error(`Surface capability catalog references missing plan: ${planId}`);
          }
          if (plan.surfaceGrant !== PRODUCT_ACCESS[surfaceId].grant) {
            throw new Error(`Surface capability catalog assigns ${planId} to the wrong surface`);
          }
          if (classifiedPlanIds.has(planId)) {
            throw new Error(`Surface capability catalog classifies a plan more than once: ${planId}`);
          }
          classifiedPlanIds.add(planId);
          return publicRoute(plan);
        });
        return {
          state: definition.state,
          label: definition.label,
          ...(definition.detail ? { detail: definition.detail } : {}),
          routes
        };
      };
      return {
        id: row.id,
        label: row.label,
        description: row.description,
        cells: {
          codex: projectCell("codex"),
          grok: projectCell("grok"),
          xai: projectCell("xai")
        }
      };
    })
  }));

  const unclassified = plans.filter((plan) => !classifiedPlanIds.has(plan.id));
  if (unclassified.length > 0) {
    throw new Error(
      `Surface capability catalog does not classify: ${unclassified.map((plan) => plan.id).join(", ")}`
    );
  }

  return { surfaces: SURFACES, groups };
}

function publicRoute(plan: ExecutionPlan): SurfaceCapabilityRoute {
  return {
    sourcePlanId: plan.id,
    hostname: plan.hostname,
    method: plan.method,
    path: publicExecutionPlanPath(plan),
    transport: plan.upgrade === "websocket" ? "websocket" : "http",
    supportStatus: plan.supportStatus
  };
}
