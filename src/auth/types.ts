export type AccountKind = "human" | "service" | "legacy_unresolved";

export interface UserRow {
  id: string;
  email: string | null;
  status: string;
  role?: "admin" | "user";
  canonical_email?: string | null;
  account_kind?: AccountKind;
  display_name?: string | null;
  login_capable?: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  key_prefix: string;
  key_hash: string;
  status: string;
  scopes: string;
  name?: string | null;
  family_id?: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface AuthenticatedUser {
  user: UserRow;
  apiKey: ApiKeyRow;
}
