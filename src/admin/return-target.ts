/** Only stable console GET locations may survive authentication. Never a callback,
 * action/API URL, external origin, or arbitrary query payload. Authority remains
 * with the destination's current server-side role and object checks. */
import { DASHBOARD_PEOPLE_PAGE_SIZES } from './ui/href';
export const CONSOLE_RETURN_SECTIONS = [
  '#content', '#top', '#keys', '#credits', '#account-keys', '#people-list', '#accounts-list', '#setup-list', '#request-history', '#add-person', '#give-access', '#capabilities', '#add-chatgpt', '#add-grok',
  '#person-detail', '#key-detail', '#account-detail', '#setup-detail', '#sync-configuration', '#request-detail', '#person-status', '#identity', '#assigned-services', '#member-key-form', '#member-key-inventory', '#usage-trends', '#usage-details',
  // Exact headings for the current three-host catalog, verified against rendered links.
  '#route-host-0-title', '#route-host-1-title', '#route-host-2-title'
] as const;
const memberViews = new Set(['home', 'keys', 'quota', 'usage', 'setup']);
const adminFields: Record<string, readonly string[]> = {
  overview: [], credentials: ['account', 'task', 'q', 'page'],
  access: ['kind', 'person', 'key', 'task', 'q', 'page', 'page_size', 'key_q', 'key_page'],
  setup: ['person', 'key', 'task', 'q', 'page'], usage: ['person', 'plan', 'model', 'q'],
  audit: ['record', 'audit_from', 'audit_to', 'audit_plan', 'audit_user', 'audit_result', 'audit_request', 'audit_cursor', 'audit_direction'],
  surfaces: [], quotas: [], 'control-audit': []
};
const safeId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !/^(?:cfwd_|sk-|Bearer)/i.test(value);
const validDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value && value <= '9998-12-31';

export function consoleReturnTarget(value: string): string | null {
  if (value.length > 4096 || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u0020\u007f\\]/.test(value) || /%(?![\da-f]{2})/i.test(value)) return null;
  const url = new URL(value, 'https://console.invalid');
  const service = /^\/me\/service-accounts\/([^/]+)$/.exec(url.pathname);
  if (url.origin !== 'https://console.invalid' || (!['/', '/admin', '/admin/'].includes(url.pathname) && !service)) return null;
  // Reject path normalization and encoded separators rather than reinterpreting an API path.
  if (url.pathname !== value.split(/[?#]/, 1)[0]) return null;
  if (service) { try { if (!safeId(decodeURIComponent(service[1]))) return null; } catch { return null; } }
  if (url.hash && !CONSOLE_RETURN_SECTIONS.some(section => section === url.hash)) return null;
  const query = url.searchParams;
  for (const [field, content] of query) {
    if (query.getAll(field).length !== 1 || content.length > (field === 'q' ? 256 : 512) || content.includes('\ufffd')
      || /[\u0000-\u001f\u007f]/.test(content) || /(?:cfwd_|sk-|Bearer\s|https?:\/\/)/i.test(content)) return null;
  }
  if (query.has('area') && (service || query.get('area') !== 'me')) return null;
  const view = query.get('view') ?? (service || query.has('area') ? 'home' : 'overview');
  // An unqualified member view is retained for existing member links. Ambiguous
  // setup/usage addresses use the union of their actual owning HTML grammars.
  const personal = (): boolean => memberViews.has(view)
    && [...query.keys()].every(field => ['view', ...(service ? [] : ['area']), ...(['keys', 'setup'].includes(view) ? ['key'] : []), ...(view === 'usage' ? ['range', 'q'] : [])].includes(field))
    && (!query.has('key') || Boolean(query.get('key')?.trim()))
    && (!query.has('range') || ['7d', '30d'].includes(query.get('range')!));
  if (service || query.has('area') || ['home', 'keys', 'quota'].includes(view)) return personal() ? value : null;
  if (personal()) return value;
  const fields = Object.hasOwn(adminFields, view) ? adminFields[view] : undefined;
  if (!fields || [...query.keys()].some(field => !['view', 'range', ...fields].includes(field))) return null;
  if (query.has('kind') && !['all', 'human', 'admin', 'service', 'legacy_unresolved'].includes(query.get('kind')!)) return null;
  if (query.has('page_size') && !DASHBOARD_PEOPLE_PAGE_SIZES.some(size => String(size) === query.get('page_size'))) return null;
  if (query.has('range') && !(['overview', 'usage'].includes(view) ? ['7d', '30d'] : ['today', '7d', '30d', 'all']).includes(query.get('range')!)) return null;
  for (const field of ['person', 'key', 'plan', 'model']) if (query.has(field) && !query.get(field)?.trim()) return null;
  for (const field of ['q', 'key_q']) if ((query.get(field)?.length ?? 0) > 256) return null;
  for (const field of ['page', 'key_page']) if (query.has(field) && (!/^[1-9]\d*$/.test(query.get(field)!) || !Number.isSafeInteger(Number(query.get(field)) * 40))) return null;
  if ((query.has('key_q') || query.has('key_page')) && !query.get('person')?.trim()) return null;
  if (query.has('account') && (!/^(codex|grok):\S[^\u0000-\u001f\u007f]*$/.test(query.get('account')!) || query.has('task'))) return null;
  if (view === 'credentials' && query.has('page') && !query.has('account')) return null;
  if (query.has('key') && (!query.get('person')?.trim() || query.has('task'))) return null;
  if (view === 'setup' && query.has('person') && !query.has('key')) return null;
  if (query.has('task')) {
    const task = query.get('task');
    if (view === 'access' ? !['add-person', 'add-service', 'give-access'].includes(task!) || task === 'give-access' && !query.get('person')?.trim()
      : view === 'credentials' ? task !== 'add-account' || query.has('person')
      : view !== 'setup' || task !== 'sync-configuration' || query.has('person')) return null;
  }
  if (view === 'audit') {
    for (const field of ['record', 'audit_plan', 'audit_request']) if (query.get(field) && !safeId(query.get(field)!.trim())) return null;
    for (const field of ['audit_from', 'audit_to']) if (query.get(field) && !validDay(query.get(field)!.trim())) return null;
    if (query.get('audit_from') && query.get('audit_to') && query.get('audit_from')! > query.get('audit_to')!) return null;
    if ((query.get('audit_user')?.length ?? 0) > 254 || /[\u0000-\u0020\u007f]/.test(query.get('audit_user') ?? '') || !['', 'ok', 'error', 'unknown'].includes(query.get('audit_result') ?? '')) return null;
    const cursor = query.get('audit_cursor');
    if (cursor) {
      if (cursor.length > 300 || !/^[A-Za-z0-9_-]+$/.test(cursor) || !['older', 'newer'].includes(query.get('audit_direction') ?? 'older')) return null;
      try {
        const decoded: unknown = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')));
        if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(decoded[0]) || !Number.isFinite(Date.parse(decoded[0])) || typeof decoded[1] !== 'string' || !safeId(decoded[1])) return null;
      } catch { return null; }
    } else if (query.has('audit_direction')) return null;
  }
  if (query.get('kind') === 'all') {
    query.set('kind', 'human');
    return url.pathname + url.search + url.hash;
  }
  return value;
}
export function consoleLoginHref(target: string): string {
  const safe = consoleReturnTarget(target);
  return safe && safe !== '/' ? `/login?${new URLSearchParams({return: safe})}` : '/login';
}
