const errors: Readonly<Record<string, string>> = {
  credit_defaults_changed: "组织额度已变化，这次没有保存。请先查看当前额度，再确认修改。",
  credit_policy_rejected: "额度修改未执行，请重新查看当前权限和额度后再操作。",
  service_not_found: "没有这个服务账号，或当前管理权限已改变。请返回我的空间重新查看。",
  service_owner_changed: "管理人未更新：人员、权限或分配已变化，请刷新后重新确认。",
  invalid_service_owner_selection: "请选择一位已启用的成员作为管理人，或选择移除分配。不选择则不会更改当前管理人。",
  invalid_service_owner_revision: "请重新打开管理人表单，确认当前分配。",
  invalid_service_name: "请填写 1 至 64 个字符的服务名称，不含控制字符。",
  service_identity_changed: "账号身份已变化，请重新查看目标后再操作。",
  human_identity_required: "只有已确认组织邮箱的人员可以登录或成为管理员。服务账号不能迁移为人员。",
  invalid_email: "请填写有效的组织邮箱。",
  invalid_email_domain: "请使用组织允许的邮箱域名。",
  email_conflict: "这个邮箱已属于另一个账号，不能合并。",
  lifecycle_rejected: "人员状态已变化，请查看当前状态后再操作。",
  last_active_admin: "必须保留至少一名可以登录的启用管理员。",
  console_identity_changed: "登录身份已经改变，请重新登录后查看当前状态。",
  key_submission_required: "请重新打开密钥表单后提交。",
  key_submission_mismatch: "这次提交已用于其他内容。请先查看当前密钥，再重新打开表单。",
  key_inventory_changed: "密钥状态已变化，这次没有创建密钥。请先查看当前密钥，再重新填写。",
  key_family_cap: "最多同时保留 5 个有效密钥（更换期间的新旧密钥算作一个）。请先撤销不再使用的密钥。",
  key_family_overlap: "这个密钥正在更换，新旧两个密钥都还有效。请先撤销其中一个，再继续更换。",
  surface_not_entitled: "所选服务当前没有可用额度（需要大于 0 或不限），暂时不能创建密钥。",
  invalid_key_name: "请填写 1 至 64 个字符的密钥名称。",
  missing_surface_grants: "请至少选择一个客户端。",
  missing_codex_credential_account_id: "请为 Codex 选择上游连接。",
  missing_grok_credential_account_id: "请为 Grok 选择上游连接。",
  missing_xai_credential_account_id: "请为 xAI API 选择上游连接。",
  invalid_expires_at_utc: "请填写有效的 UTC 到期时间，或留空。",
  invalid_expires_at: "请重新选择有效期。",
  expiry_in_past: "到期时间必须晚于现在。",
  expiry_too_far: "有效期最多为一年，请重新选择。",
  invalid_monthly_allowance: "每月额度必须是大于或等于 0 的整数。",
  surface_disabled: "这个客户端没有可用额度。请检查个人额度和组织默认额度。",
  replacement_bindings_unavailable: "原绑定当前不可用或不完整，请管理员处理后重试。",
  credential_not_selectable: "这个上游连接已不可用，请重新选择。",
  credential_paused: "这个 ChatGPT 连接已暂停接收请求。请管理员恢复，或改用其他连接。",
  credential_admission_unconfirmed: "请求准入的更改结果尚未确认。请先查看当前状态，不要重复提交。",
  credential_binding_changed: "密钥或连接已变化，这次没有更改绑定。请先查看当前状态，再确认。",
  credential_default_unavailable: "默认上游连接当前不可用。请管理员检查上游连接和默认设置。",
  credential_disconnect_blocked: "还有有效密钥在使用这个连接。请先迁移或撤销这些密钥，再断开。",
  missing_replacement_account_id: "请选择兼容的替代连接。",
  missing_credential_account_id: "请选择新密钥的默认连接。",
  retirement_target_required: "请明确选择要迁移的密钥或默认连接。",
  retirement_unchanged: "这次没有迁移任何项目。请先查看当前绑定和默认连接，再确认。",
  credential_cleanup_not_ready: "此连接尚未断开，不能清理令牌。请先查看当前连接。",
  key_not_active: "这个密钥已不可用，请刷新后查看当前状态。",
  key_not_found: "没有找到这个密钥，请刷新后查看当前状态。",
  user_inactive: "这个账号已停用，不能创建或更换密钥。请联系管理员。",
  admin_auth_required: "登录已过期，请重新登录后查看当前状态。",
  admin_required: "这项操作需要管理员权限，请联系管理员。",
  missing_refresh_token: "这个连接无法刷新，请重新连接。",
  reauth_required: "上游授权已失效，请重新连接。",
  codex_token_refresh_failed: "刷新失败：上游服务暂时无法完成刷新。请稍后重试；页面上的连接状态不代表上游可用。",
  invalid_token_response: "刷新失败：上游返回的凭据无效。请稍后重试。",
  missing_access_token: "刷新失败：上游返回的凭据不完整。请先查看当前连接。",
  codex_auth_inactive: "这个连接当前不可用，请查看连接状态后重新连接。",
  credential_lifecycle_changed: "连接在刷新期间发生了变化，请查看当前状态后再操作。"
};

export function consoleErrorMessage(code: string | null): string {
  const message = code && Object.hasOwn(errors, code) ? errors[code] : undefined;
  return message ?? "这次操作没有执行。请检查填写的内容和当前状态，再提交。";
}
/** The rendered copy plus a stable code for `data-error-code`; tests assert the code, not the sentence. */
export function consoleError(code: string | null | undefined): {readonly message: string; readonly error_code: string} {
  return {message: consoleErrorMessage(code ?? null), error_code: code ?? "unknown"};
}
export function consoleErrorCode(value: unknown): unknown {
  return value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "code" in value.error ? value.error.code : null;
}

export function readConsoleRejection(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  const error = value.error;
  if (typeof error !== "object" || error === null || !("message" in error) || typeof error.message !== "string") return null;
  return consoleErrorMessage("code" in error && typeof error.code === "string" ? error.code : null);
}
export function personInputMessage(error: {readonly message: string}): string {
  return error.message;
}
