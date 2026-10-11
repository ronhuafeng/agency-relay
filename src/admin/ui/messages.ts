const errors: Readonly<Record<string, string>> = {
  credit_defaults_changed: "组织额度已变化，这次没有保存。请先查看当前额度，再确认修改。",
  credit_policy_rejected: "额度修改未执行，请重新查看当前权限和额度后再操作。",
  service_not_found: "没有这个服务账号，或当前管理权限已改变。请返回我的空间重新查看。",
  service_owner_changed: "管理人未更新：人员、权限或分配已变化，请刷新后重新确认。",
  invalid_service_owner_selection: "请明确选择启用的管理人，或选择移除分配。未选择不会更改当前管理人。",
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
  key_submission_mismatch: "这个提交标识已用于其他内容。请先查看当前密钥，再重新打开表单。",
  key_inventory_changed: "密钥状态已变化，这次没有发行。请先读取当前密钥再重新填写。",
  key_family_cap: "已达到五个有效家族的上限。请先撤销不再使用的家族。",
  key_family_overlap: "这个家族已有两个有效 secret。请先结束已有重叠。",
  surface_not_entitled: "所选服务需要正的有限额度或不限政策，当前条件不允许发行。",
  invalid_key_name: "请填写 1 至 64 个字符的密钥名称。",
  missing_surface_grants: "请至少选择一个客户端。",
  missing_codex_credential_account_id: "请为 Codex 选择账号。",
  missing_grok_credential_account_id: "请为 Grok 选择账号。",
  missing_xai_credential_account_id: "请为 xAI API 选择账号。",
  invalid_expires_at_utc: "请填写有效的 UTC 到期时间，或留空。",
  invalid_expires_at: "请重新选择有效期。",
  expiry_in_past: "到期时间必须晚于现在。",
  expiry_too_far: "有效期最多为一年，请重新选择。",
  invalid_monthly_allowance: "每月额度必须是大于或等于 0 的整数。",
  surface_disabled: "这个客户端没有可用额度。请检查个人额度和组织默认额度。",
  replacement_bindings_unavailable: "原绑定当前不可用或不完整，请管理员处理后重试。",
  credential_not_selectable: "这个账号已不可用，请重新选择账号。",
  credential_paused: "这个 ChatGPT 账号已暂停。请管理员恢复请求准入，或明确更改绑定。",
  credential_admission_unconfirmed: "请求准入结果尚未确认。请先查看当前状态，不要重复提交。",
  credential_binding_changed: "密钥或连接已变化，这次没有更改绑定。请先读取当前状态再确认。",
  credential_default_unavailable: "当前默认账号不可用，请管理员检查账号连接和组织默认设置。",
  credential_disconnect_blocked: "还有有效密钥使用这个账号。请先处理这些密钥，再断开账号。",
  missing_replacement_account_id: "请选择兼容的替代连接。",
  missing_credential_account_id: "请选择新密钥的默认连接。",
  retirement_target_required: "请明确选择要迁移的密钥或默认连接。",
  retirement_unchanged: "本次没有迁移项目。请先读取当前绑定和默认连接，再确认。",
  credential_cleanup_not_ready: "此连接尚未断开，不能清理令牌。请先查看当前连接。",
  key_not_active: "这个密钥已不可用，请刷新后查看当前状态。",
  key_not_found: "没有找到这个密钥，请刷新后查看当前状态。",
  user_inactive: "这个账号已停用，不能发行或更换密钥。请管理员检查账号状态。",
  admin_auth_required: "登录已过期，请重新登录后查看当前状态。",
  admin_required: "这项操作需要管理员权限，请联系管理员。",
  missing_refresh_token: "这个账号不能刷新，请重新连接。",
  reauth_required: "账号授权已失效，请重新连接。",
  codex_token_refresh_failed: "刷新账号失败，上游服务暂时无法完成刷新。请稍后重试；当前连接状态不代表上游可用。",
  invalid_token_response: "刷新账号失败，上游返回的凭据无效。请稍后重试。",
  missing_access_token: "刷新账号失败，上游返回的凭据不完整。请查看当前连接后再处理。",
  codex_auth_inactive: "这个账号当前不可用，请查看连接状态后重新连接。",
  credential_lifecycle_changed: "账号连接在刷新期间已改变，请查看当前状态后再操作。"
};

export function consoleErrorMessage(code: string | null): string {
  const message = code && Object.hasOwn(errors, code) ? errors[code] : undefined;
  return message ?? "服务器未接受这次操作。请检查填写的内容和当前状态，再提交。";
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
