import { keyLifecycle } from "../auth/key-state";
export { keyIsExpired } from "../auth/key-state";

export function keyStateLabel(
  key: { readonly status: string; readonly expires_at: string | null },
  person: { readonly status: string } | undefined,
  nowMs: number
): string {
  const state = keyLifecycle(key, person?.status, nowMs).state;
  if (state === "revoked") return "已撤销";
  if (state === "expired") return "已过期";
  if (state === "paused") return person?.status !== "active" ? "已暂停 — 人员已停用" : "已暂停";
  if (state === "unknown") return "人员未加载";
  return state === "active" ? "有效" : "不可用";
}
