import {expect, it} from 'vitest';
import {consoleLoginHref, consoleReturnTarget} from '../../src/admin/return-target';

it('normalizes the removed mixed-account category to the member category through login', () => {
  const original = '/admin?view=access&kind=all&q=example&page_size=10&page=2#people-list';
  const current = '/admin?view=access&kind=human&q=example&page_size=10&page=2#people-list';
  expect(consoleReturnTarget(original)).toBe(current);
  expect(consoleLoginHref(original)).toBe(`/login?${new URLSearchParams({return: current})}`);
});

it.each([
  '/', '/admin', '/admin/', '/admin?view=overview&range=7d', '/admin?view=overview&range=30d#usage-trends', '/admin?view=access&kind=service&q=build#people-list', '/admin?area=me&view=usage&range=7d', '/admin?area=me&view=usage&range=30d#content',
  '/?view=usage&range=30d', '/admin?view=access&person=member&q=example%40test&range=all#credits',
  '/admin?view=access&task=add-service', '/admin?view=credentials&account=codex%3Atest&page=2',
  ...['10','20','40'].map(size => `/admin?view=access&kind=admin&q=operator&page=2&page_size=${size}#people-list`),
  '/admin?view=setup&person=member&key=key-one#content', '/admin?view=setup&key=key-one',
  '/admin?view=usage&person=service&plan=codex.production.responses&model=test&range=30d',
  '/admin?view=audit&audit_from=2026-10-01&audit_to=2026-10-03&audit_result=error&record=audit-one',
  ...['home', 'keys', 'quota', 'usage', 'setup'].map(view => `/me/service-accounts/svc_one?view=${view}`),
  '/me/service-accounts/svc%3Aone?view=keys&key=key-one#keys',
  '/me/service-accounts/svc_one?view=setup&key=key-one#content',
  '/me/service-accounts/svc_one?view=usage&range=30d#content'
])('preserves exact owned HTML location: %s', target => expect(consoleReturnTarget(target)).toBe(target));

it.each([
  '/admin?view=access&kind=unknown', '/admin?view=usage&kind=human', '//evil.invalid/', '/admin/../admin', '/me/service-accounts/../admin', '/me/service-accounts/svc%2Fkeys',
  ...['0','15','10.0','', '9999999'].map(size => `/admin?view=access&page_size=${size}`),
  '/admin?view=access&page_size=10&page_size=20', '/admin?view=setup&page_size=20', '/admin?view=quotas&page_size=20',
  '/me/service-accounts/svc%252Fkeys', '/me/service-accounts/%FF', '/me/service-accounts/%',
  '/me/service-accounts', '/me/service-accounts/svc_one/', '/me/service-accounts/svc_one/usage',
  '/me/service-accounts/svc_one/setup', '/me/service-accounts/svc_one/ui/keys', '/me/service-accounts/svc_one/keys',
  '/me/service-accounts/svc_one?area=me', '/me/service-accounts/svc_one?view=access',
  '/me/service-accounts/svc_one?view=usage&range=all', '/me/service-accounts/svc_one?view=usage&key=key-one',
  '/me/service-accounts/svc_one?view=keys&range=30d', '/me/service-accounts/svc_one?view=home&key=key-one',
  '/me/service-accounts/svc_one?view=setup&key=cfwd_secret', '/me/service-accounts/svc_one?view=usage&user_id=other',
  '/admin?area=me&view=usage&range=365d', '/admin?area=me&view=usage&range=7d&range=30d',
  '/admin?area=me&view=usage&person=other', '/admin?area=me&view=quota&range=30d',
  '/admin?area=me&view=setup&account=codex%3Aone', '/admin?view=__proto__', '/admin?view=overview&key=key-one',
  '/admin?view=access&account=codex%3Aone', '/admin?view=usage&range=today', '/admin?view=overview&range=today', '/admin?view=overview&range=all', '/admin?range=all', '/admin?view=usage&plan=',
  '/admin?view=credentials&page=2', '/admin?view=access&key_q=query', '/admin?view=access&page=0',
  '/admin?view=access&task=anything', '/admin?view=setup&person=member', '/admin?view=audit&audit_to=2026-02-30',
  '/admin?view=audit&audit_cursor=opaque', '/admin?view=audit&audit_direction=newer', '/admin?view=access&record=one'
])('rejects a cross-route, malformed or sensitive return: %s', target => expect(consoleReturnTarget(target)).toBeNull());


it.each([
  ...['person-detail', 'person-status', 'identity', 'assigned-services'].map(section => `/admin?view=access&person=other&q=other&range=30d#${section}`),
  ...['member-key-form', 'member-key-inventory'].map(section => `/admin?area=me&view=keys#${section}`),
  '/me/service-accounts/svc_one?view=keys&key=key-one#member-key-inventory',
  '/admin?view=audit&audit_user=other&audit_result=error#request-history',
  ...['usage-trends', 'usage-details'].map(section => `/admin?view=usage&person=other&range=30d#${section}`),
  '/me/service-accounts/svc_one?view=usage&range=30d#usage-trends',
  ...[0, 1, 2].map(index => `/admin?view=surfaces#route-host-${index}-title`)
])('retains an actual task section and its exact object/query through login: %s', target => {
  expect(consoleLoginHref(target)).toBe(`/login?${new URLSearchParams({return: target})}`);
  expect(consoleReturnTarget(target)).toBe(target);
});

it.each([
  '/admin?view=access&person=other#unknown-section',
  '/admin?view=audit#activity-summary',
  '/admin?view=access&person=other#identity/callback',
  '/admin?view=access&person=other#%69dentity',
  '/admin?view=access&person=other#cfwd_secret',
  ...['-1', '00', '3', '999999999'].map(index => `/admin?view=surfaces#route-host-${index}-title`),
  '/me/service-accounts/svc_one/ui/keys#member-key-form',
  '/me/service-accounts/svc_one?view=keys&key=cfwd_secret#member-key-inventory',
  '/admin?view=access&person=other&return=https://evil.invalid/#identity'
])('keeps unknown/unsafe task fragments and URLs rejected: %s', target => {
  expect(consoleReturnTarget(target)).toBeNull();
  expect(consoleLoginHref(target)).toBe('/login');
});
