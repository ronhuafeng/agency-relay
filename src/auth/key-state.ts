import { parseIsoMillis } from "../crypto";

export interface KeyLifecycle {
  state: "active" | "expired" | "revoked" | "paused" | "inactive" | "unknown";
  expiry: "unbounded" | "future" | "elapsed" | "unrecognized";
  owner_active: boolean | null;
}

export function keyIsExpired(key: { expires_at: string | null }, nowMs: number): boolean {
  const expiry = parseIsoMillis(key.expires_at);
  return expiry !== undefined && expiry <= nowMs;
}

/** Mirrors key authentication; it says nothing about upstream health or credits. */
export function keyLifecycle(key: { status: string; expires_at: string | null }, ownerStatus: string | null | undefined, nowMs: number): KeyLifecycle {
  const expired = keyIsExpired(key, nowMs);
  const expiry = key.expires_at === null ? "unbounded" : parseIsoMillis(key.expires_at) === undefined ? "unrecognized" : expired ? "elapsed" : "future";
  const owner_active = ownerStatus == null ? null : ownerStatus === "active";
  const state = key.status !== "active"
    ? key.status === "revoked" ? "revoked" : key.status === "expired" ? "expired" : key.status === "paused" ? "paused" : "inactive"
    : expired ? "expired" : owner_active === null ? "unknown" : owner_active ? "active" : "paused";
  return { state, expiry, owner_active };
}

/** Issuance counts live secrets/families independently of the owner's current status. */
export function keyIsLive(key: { status: string; expires_at: string | null }, nowMs: number): boolean {
  return key.status === "active" && !keyIsExpired(key, nowMs);
}
