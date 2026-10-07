import type { ServiceContext } from "../auth/service-delegation";

export interface ServiceKeyImpact {
  id: string;
  name: string | null;
  key_prefix: string;
  status: string;
  expires_at: string | null;
}
export type AssignedServiceImpact = { known: false } | {
  known: true;
  services: Array<ServiceContext & { keys: ServiceKeyImpact[] | null; moreKeys: boolean }>;
  moreServices: boolean;
};

/** Administrator-only human detail projection. Never a bearer inventory or a claim
 * that this human has no previously copied credentials outside current assignments. */
export async function readAssignedServiceImpact(env: Env, humanId: string): Promise<AssignedServiceImpact> {
  let services: ServiceContext[];
  try {
    const result = await env.DB.prepare(`SELECT service.id, service.display_name, service.status
      FROM service_account_owners AS assignment JOIN users AS service ON service.id = assignment.service_user_id
      WHERE assignment.owner_user_id = ? AND service.account_kind = 'service'
      ORDER BY service.display_name, service.id LIMIT 21`).bind(humanId).all<ServiceContext>();
    services = result.results ?? [];
  } catch { return { known: false }; }
  const rows = await Promise.all(services.slice(0, 20).map(async service => {
    try {
      const result = await env.DB.prepare(`SELECT id, name, key_prefix, status, expires_at FROM api_keys
        WHERE user_id = ? ORDER BY created_at, id LIMIT 11`).bind(service.id).all<ServiceKeyImpact>();
      const keys = result.results ?? [];
      return { ...service, keys: keys.slice(0, 10), moreKeys: keys.length > 10 };
    } catch { return { ...service, keys: null, moreKeys: false }; }
  }));
  return { known: true, services: rows, moreServices: services.length > 20 };
}
