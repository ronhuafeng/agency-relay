import { consoleActorId, type ConsoleOutcome } from './authority';
import { consoleLoginHref, consoleReturnTarget, CONSOLE_RETURN_SECTIONS } from '../return-target';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { RecoveryPage, type RecoveryState } from '../ui/recovery-page';

function recoveryTarget(): string {
  const current = new URL(location.href);
  const main = document.querySelector<HTMLElement>('main#content');
  const read = main?.dataset.consoleReadUrl ?? main?.dataset.dashboardUrl
    ?? main?.querySelector<HTMLElement>('[data-member-return]')?.dataset.memberReturn;
  if (read) {
    try {
      const target = new URL(read, current);
      const servicePath = /^\/me\/service-accounts\/[^/]+/.exec(current.pathname)?.[0];
      const personal = !servicePath && (current.searchParams.get('area') === 'me' || current.pathname.startsWith('/me/ui/keys') || Boolean(document.querySelector('[data-member-nav]')));
      const consolePath = (path: string): boolean => ['/', '/admin', '/admin/'].includes(path);
      const sameScope = servicePath ? target.pathname === servicePath : personal ? consolePath(target.pathname) && target.searchParams.get('area') === 'me' : consolePath(target.pathname) && !target.searchParams.has('area');
      const samePath = target.pathname === current.pathname || consolePath(current.pathname) && consolePath(target.pathname);
      const nativeResult = servicePath ? current.pathname.startsWith(`${servicePath}/ui/keys`)
        : personal ? current.pathname.startsWith('/me/ui/keys') : current.pathname.startsWith('/admin/ui/');
      // Local selection and native POST results can project a canonical GET.
      // Both must keep this document's personal, service or organization scope.
      if (target.origin === current.origin && sameScope && (samePath || nativeResult)) {
        const safe = consoleReturnTarget(target.pathname + target.search);
        if (safe) return safe + (CONSOLE_RETURN_SECTIONS.some(section => section === current.hash) ? current.hash : '');
      }
    } catch { /* Invalid metadata cannot prevent privacy cleanup. */ }
  }
  return consoleReturnTarget(current.pathname + current.search + current.hash) ?? '/';
}

function currentOutcome(outcome: ConsoleOutcome): Exclude<ConsoleOutcome, 'read'> | undefined {
  if (outcome !== 'read') return outcome;
  const main = document.querySelector<HTMLElement>('main#content');
  const recorded = main?.dataset.consoleOutcome;
  if (recorded === 'confirmed' || recorded === 'rejected' || recorded === 'unknown') return recorded;
  if (document.querySelector('[data-mutation-pending="true"],form[aria-busy="true"]')
    || main?.dataset.memberMutationBlocked === 'true' || main?.dataset.dashboardMutationBlocked === 'true') return 'unknown';
  if (main?.querySelector('[data-one-time-key],[data-member-result="confirmed"]')
    || main?.dataset.dashboardMutation && !main.dataset.dashboardMutation.endsWith('_error')) return 'confirmed';
  if (main?.querySelector('[data-member-result="rejected"]') || main?.dataset.dashboardMutation?.endsWith('_error')) return 'rejected';
  return undefined;
}

/** A document restored by the browser has no fresh server authority. Discard it
 * on departure, then offer a normal, exact GET. Background checks do not replay
 * writes or reload a still-authorized user's unfinished work. */
export function initializeRecovery(dispose: () => void): () => void {
  if (!document.querySelector('[data-console-email][data-console-role]')) return () => {};
  const actorId = consoleActorId();
  const serviceId = document.querySelector<HTMLElement>('[data-service-id]')?.dataset.serviceId;
  const serviceStatus = document.querySelector<HTMLElement>('[data-service-id]')?.dataset.serviceStatus;
  const listeners = new AbortController(); const signal = listeners.signal;
  let ended = false;
  let generation = 0;
  let check: AbortController | null = null;
  let checking: HTMLElement | null = null;
  let publicRoot: Root | null = null;
  let returnFocus: HTMLElement | null = null;
  const privateNodes = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.shell,.identity'));
  const mask = (pending: boolean): void => {
    document.documentElement.toggleAttribute('data-console-authority-pending', pending);
    document.body.inert = pending;
    privateNodes().forEach(node => { node.hidden = pending; node.inert = pending; });
  };
  const invalidate = (): void => { generation++; check?.abort(); check = null; checking?.remove(); checking = null; };
  const show = (message: string, target: string, state: RecoveryState, outcome: Exclude<ConsoleOutcome, 'read'> | undefined): void => {
    const main = document.createElement('main'); main.id = 'content'; main.tabIndex = -1;
    document.querySelector('.site-header')?.after(main);
    publicRoot = createRoot(main);
    flushSync(() => publicRoot!.render(createElement(RecoveryPage, {state, description: message, href: state === 'login' ? consoleLoginHref(target) : target, outcome})));
    const heading = main.querySelector<HTMLElement>('h1');
    document.title = `${heading?.textContent ?? '重新打开页面'} · Agency Relay`;
    heading?.focus({preventScroll: true});
  };
  const clear = (message: string, state: RecoveryState = 'unavailable', outcome: ConsoleOutcome = 'read'): void => {
    if (ended) return;
    const target = recoveryTarget(); const result = currentOutcome(outcome);
    ended = true; invalidate(); dispose();
    // No hidden snapshots, detached React roots, dialogs, or serialized props survive.
    privateNodes().forEach(node => node.remove());
    document.querySelectorAll('script[type="application/json"],[data-ui-props],#console-dialog-root').forEach(node => node.remove());
    returnFocus = null;
    mask(false);
    show(message, target, state, result);
  };
  document.addEventListener('console:actor-changed', event => {
    const {outcome, changed, reason} = (event as CustomEvent<{outcome: ConsoleOutcome; changed: boolean; reason?: "authority"}>).detail;
    clear(reason === "authority" ? '当前登录或页面权限已改变。请重新打开以读取获准访问的内容。' : changed ? '当前账号已改变。请重新打开页面；原账号的内容和草稿已清除。' : '无法确认页面的当前账号。请重新打开；原内容和草稿已清除。', reason === 'authority' || changed ? 'authority' : 'unavailable', outcome);
  }, {signal});
  const stop = (): void => { ended = true; invalidate(); listeners.abort(); returnFocus = null; publicRoot?.unmount(); publicRoot = null; mask(false); };
  document.addEventListener('console:document-ended', () => { stop(); dispose(); }, {signal});
  if (!actorId) { clear('无法确认这个页面的原账号。请重新打开以读取当前身份。'); return stop; }
  window.addEventListener('pagehide', () => clear('页面已离开。重新打开后按当前账号和权限读取；不会重复提交操作。', 'reopen'), {signal});
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      clear('页面已恢复。请重新读取当前账号和权限；不会重复提交操作。', 'reopen');
      document.querySelector<HTMLElement>('[data-console-recovery] a')?.focus();
    }
  }, {signal});
  document.addEventListener('visibilitychange', async () => {
    if (ended) return;
    if (!document.documentElement.hasAttribute('data-console-authority-pending')) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    invalidate(); mask(true);
    if (document.visibilityState !== 'visible') return;
    const epoch = generation;
    const controller = new AbortController(); check = controller;
    const current = (): boolean => !ended && epoch === generation && check === controller && document.visibilityState === 'visible';
    checking = document.createElement('p'); checking.dataset.consoleAuthorityStatus = ''; checking.setAttribute('role', 'status'); checking.textContent = '正在确认当前账号和权限…'; document.body.append(checking);
    const timeout = window.setTimeout(() => { if (current()) clear('无法确认当前账号和权限。请连接网络后重试；没有排队或重复提交操作。'); }, 10000);
    try {
      const response = await fetch('/me', {headers: {Accept: 'application/json'}, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal});
      if (!response.ok && response.status !== 401 && response.status !== 403) throw new Error('Authority unavailable');
      const data: unknown = response.ok || response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : null;
      if (!current()) return;
      if (!response.ok) {
        const code = data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' && 'code' in data.error ? data.error.code : null;
        const login = response.status === 401 || ['admin_auth_required', 'console_identity_changed'].includes(String(code));
        clear(login ? '当前登录已失效。重新登录后，将打开原页面并检查访问权限。' : '当前登录或页面权限已经改变。请重新打开以读取获准访问的内容。', login ? 'login' : 'authority'); return;
      }
      const user = data && typeof data === 'object' && 'user' in data ? data.user : null;
      if (response.ok && (!user || typeof user !== 'object' || !('id' in user) || typeof user.id !== 'string' || !user.id || !('email' in user) || typeof user.email !== 'string'
        || !('role' in user) || !['admin', 'user'].includes(String(user.role)) || !('status' in user) || !['active', 'disabled'].includes(String(user.status)))) throw new Error('Invalid authority projection');
      // Accepted navigation can replace the header for the same actor. Compare
      // with that current server projection, not a detached former header.
      const identity = document.querySelector<HTMLElement>('[data-console-email][data-console-role]');
      const same = identity && user && typeof user === 'object' && 'id' in user && 'email' in user && 'role' in user && 'status' in user
        && user.id === actorId && user.email === identity.dataset.consoleEmail && user.role === identity.dataset.consoleRole && user.status === 'active';
      if (!same) { clear('当前登录或权限已经改变。请重新打开以查看获准访问的页面。', 'authority'); return; }
      if (serviceId) {
        // /me identifies the human actor. It cannot establish a still-current
        // service delegation, which may change without changing that human.
        const response = await fetch(`/me/service-accounts/${encodeURIComponent(serviceId)}`, {headers: {Accept: 'application/json'}, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal});
        if (!response.ok && ![401, 403, 404].includes(response.status)) throw new Error('Service authority unavailable');
        const data: unknown = response.ok ? await response.json() : null;
        if (!current()) return;
        const actual = data && typeof data === 'object' && 'service' in data ? data.service : null;
        if (response.ok && (!actual || typeof actual !== 'object' || !('id' in actual) || actual.id !== serviceId
          || !('status' in actual) || !['active', 'disabled'].includes(String(actual.status)))) throw new Error('Invalid service projection');
        if (!actual || typeof actual !== 'object' || !('id' in actual) || actual.id !== serviceId
          || !('status' in actual) || actual.status !== serviceStatus) {
          clear('当前服务账号或管理权限已经改变。请重新打开以查看获准访问的页面。', response.status === 401 ? 'login' : 'authority'); return;
        }
      }
      mask(false);
      if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({preventScroll: true});
      returnFocus = null;
    } catch {
      if (current()) clear('无法确认当前账号和权限。请连接网络后重试；没有排队或重复提交操作。');
    } finally {
      clearTimeout(timeout);
      if (current()) { check = null; checking?.remove(); checking = null; }
    }
  }, {signal});
  return stop;
}
