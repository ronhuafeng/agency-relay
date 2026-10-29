import { personLabel } from "./format";
import { inventoryUrl } from "./ui/href";

export interface ControlAuditRow {
  readonly at: string;
  readonly actor_kind: string;
  readonly actor_email: string | null;
  readonly actor_role: string | null;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly result: string;
  readonly target_label: string | null;
  readonly target_href: string | null;
}

interface JoinedAuditRow extends Omit<ControlAuditRow, "target_label" | "target_href"> {
  readonly person_id: string | null;
  readonly email: string | null;
  readonly account_kind: string | null;
  readonly display_name: string | null;
  readonly key_id: string | null;
  readonly key_owner: string | null;
  readonly key_prefix: string | null;
  readonly codex_id: string | null;
  readonly codex_label: string | null;
  readonly grok_id: string | null;
  readonly grok_label: string | null;
}

/** Current object labels aid navigation; historical actor snapshots stay untouched.
 * Resolve only the bounded audit window. Never read credentials or probe providers. */
export async function readControlAudit(env: Env, canonicalUrl: string): Promise<{ rows: ControlAuditRow[]; truncated: boolean }> {
  const result = await env.DB.prepare(`
    WITH recent AS (
      SELECT id, at, actor_kind, actor_email, actor_role, action, target_type, target_id, result
      FROM operator_mutation_audit ORDER BY at DESC, id DESC LIMIT 101
    )
    SELECT a.at, a.actor_kind, a.actor_email, a.actor_role, a.action, a.target_type, a.target_id, a.result,
      u.id AS person_id, u.email, u.account_kind, u.display_name,
      k.id AS key_id, k.user_id AS key_owner, k.key_prefix,
      c.id AS codex_id, c.label AS codex_label, g.id AS grok_id, g.label AS grok_label
    FROM recent a
    LEFT JOIN users u ON a.target_type = 'user' AND u.id = a.target_id
    LEFT JOIN api_keys k ON a.target_type = 'api_key' AND k.id = a.target_id
    LEFT JOIN codex_auths c ON a.target_type = 'codex_auth' AND c.id = a.target_id AND c.kind = 'shared' AND c.environment = 'production'
    LEFT JOIN subscription_accounts g ON a.target_type = 'subscription_account' AND g.id = a.target_id AND g.capability_source = 'grok'
    ORDER BY a.at DESC, a.id DESC
  `).all<JoinedAuditRow>();
  return {
    truncated: result.results.length > 100,
    rows: result.results.slice(0, 100).map((row) => {
      let target_label: string | null = null;
      let target_href: string | null = null;
      if (row.person_id) {
        target_label = personLabel({ id: row.person_id, email: row.email, account_kind: row.account_kind ?? undefined, display_name: row.display_name });
        target_href = inventoryUrl(canonicalUrl, { view: "access", person: row.person_id });
      } else if (row.key_id && row.key_owner) {
        target_label = row.key_prefix;
        target_href = inventoryUrl(canonicalUrl, { view: "access", person: row.key_owner, key: row.key_id });
      } else if (row.codex_id || row.grok_id) {
        target_label = row.codex_id ? row.codex_label : row.grok_label;
        target_href = inventoryUrl(canonicalUrl, { view: "credentials", account: row.codex_id ? `codex:${row.codex_id}` : `grok:${row.grok_id}` });
      }
      return { at: row.at, actor_kind: row.actor_kind, actor_email: row.actor_email, actor_role: row.actor_role,
        action: row.action, target_type: row.target_type, target_id: row.target_id, result: row.result, target_label, target_href };
    })
  };
}
