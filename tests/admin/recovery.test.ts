/** @vitest-environment jsdom */
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createNavigation} from '../../src/admin/client/navigation';
import {createDrafts} from '../../src/admin/client/drafts';
import {initializeMutations} from '../../src/admin/client/mutations';
import {initializeMemberMutations} from '../../src/admin/client/member-mutations';
import {browserLayout,dashboardHtml,submit} from '../support/browser-dom';
import {initializeRecovery} from '../../src/admin/client/recovery';
let stop = () => {};
beforeEach(() => {
  history.replaceState(null, '', '/admin?area=me&view=setup&key=exact#content');
  document.body.innerHTML = '<header class="site-header"><div class="identity" data-console-actor-id="actor-A" data-console-email="viewer@example.test" data-console-role="user"></div></header><div class="shell"><main id="content"><form><input value="unfinished"><section data-one-time-key>INVALID-DISPLAY-ONLY</section></form></main></div>';
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {stop(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
it('discards private DOM on departure and offers a stable exact GET without fetching or submitting', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const dispose = vi.fn(); stop = initializeRecovery(dispose);
  // Deterministic handler test only; this synthetic event is not BFCache evidence.
  window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
  expect(dispose).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  expect(document.querySelector('.shell,.identity,[data-one-time-key]')).toBeNull();
  expect(document.querySelector('main a')?.getAttribute('href')).toBe('/admin?area=me&view=setup&key=exact#content');
});
it('keeps unfinished work when a fresh foreground check confirms the same current authority', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({user:{id:'actor-A',email:'viewer@example.test',role:'user',status:'active'}})); vi.stubGlobal('fetch', fetch);
  const dispose = vi.fn(); stop = initializeRecovery(dispose); document.dispatchEvent(new Event('visibilitychange'));
  expect(document.querySelector<HTMLElement>('.shell')?.hidden).toBe(true);
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.shell')?.hidden).toBe(false));
  expect(document.querySelector('input')?.value).toBe('unfinished'); expect(dispose).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledWith('/me', expect.objectContaining({credentials:'same-origin',cache:'no-store',redirect:'error'}));
});
it('returns focus to the same connected task after a successful foreground check', async () => {
  browserLayout(); const field = document.querySelector<HTMLInputElement>('input')!; field.focus();
  let complete!: (response: Response) => void;
  vi.stubGlobal('fetch',vi.fn().mockReturnValue(new Promise<Response>(done=>{complete=done;})));
  stop = initializeRecovery(vi.fn()); document.dispatchEvent(new Event('visibilitychange'));
  expect(document.querySelector<HTMLElement>('.shell')?.hidden).toBe(true);
  document.body.focus();
  complete(Response.json({user:{id:'actor-A',email:'viewer@example.test',role:'user',status:'active'}}));
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.shell')?.hidden).toBe(false));
  expect(document.activeElement).toBe(field); expect(field.value).toBe('unfinished');
});
it.each([
  [401,'authentication_error','login'],
  [403,'admin_required','authority'],
  [503,'unavailable','unavailable']
] as const)('keeps a %s authority result in its truthful recovery state', async (status,code,state) => {
  const fetch = vi.fn().mockResolvedValue(Response.json({error:{code}},{status})); vi.stubGlobal('fetch',fetch);
  stop = initializeRecovery(vi.fn()); document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(document.querySelector('[data-console-recovery]')).not.toBeNull());
  expect(document.querySelector('[data-console-recovery]')?.getAttribute('data-recovery-state')).toBe(state);
  expect(document.activeElement?.tagName).toBe('H1');
  expect(document.querySelector('.shell,.identity,form,[data-one-time-key]')).toBeNull();
  expect(document.body.textContent?.includes('登录已失效')).toBe(state === 'login');
  expect(fetch).toHaveBeenCalledOnce();
});
it('uses an accepted replacement header for the same actor on the next foreground read', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({user:{id:'actor-A',email:'viewer@example.test',role:'admin',status:'active'}})));
  const dispose = vi.fn(); stop = initializeRecovery(dispose);
  document.querySelector('.site-header')!.outerHTML = '<header class="site-header"><div class="identity" data-console-actor-id="actor-A" data-console-email="viewer@example.test" data-console-role="admin"></div></header>';
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.shell')?.hidden).toBe(false));
  expect(document.querySelector('input')?.value).toBe('unfinished'); expect(dispose).not.toHaveBeenCalled();
});
it.each([['changed role',200,{user:{id:'actor-A',email:'viewer@example.test',role:'admin',status:'active'}}],['changed account',200,{user:{id:'actor-A',email:'other@example.test',role:'user',status:'active'}}],['expired session',403,{error:{code:'admin_auth_required'}}]] as const)('clears stale authority on %s without automatic navigation or writes', async (_name,status,body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body,{status}))); stop = initializeRecovery(vi.fn()); document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(document.querySelector('[data-console-recovery]')).not.toBeNull());
  expect(document.querySelector('.shell,.identity,[data-one-time-key]')).toBeNull();
  const url = new URL(document.querySelector<HTMLAnchorElement>('main a')!.href);
  expect(status === 403 ? url.searchParams.get('return') : url.pathname+url.search+url.hash).toBe('/admin?area=me&view=setup&key=exact#content');
});
it('does not restore stale DOM if an earlier authority read finishes after departure', async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(done => {resolve=done;})));
  stop = initializeRecovery(vi.fn()); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new PageTransitionEvent('pagehide'));
  resolve(Response.json({user:{id:'actor-A',email:'viewer@example.test',role:'user',status:'active'}}));
  await new Promise(done => setTimeout(done, 0));
  expect(document.querySelector('.shell,.identity,[data-one-time-key]')).toBeNull();
});

it.each([['unchanged',200,'active'],['transferred',404,'active'],['disabled',200,'disabled'],['unavailable',503,'active']] as const)('checks delegated service authority separately from the human: %s', async (scenario,status,currentStatus) => {
  const target = '/me/service-accounts/svc_one?view=usage&range=30d#content';
  history.replaceState(null, '', target);
  document.querySelector('main')!.setAttribute('data-service-id','svc_one');
  document.querySelector('main')!.setAttribute('data-service-status','active');
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({user:{id:'actor-A',email:'viewer@example.test',role:'user',status:'active'}}))
    .mockResolvedValueOnce(Response.json({service:{id:'svc_one',status:currentStatus}},{status}));
  vi.stubGlobal('fetch',fetch); const dispose = vi.fn(); stop = initializeRecovery(dispose); document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch).toHaveBeenLastCalledWith('/me/service-accounts/svc_one',expect.objectContaining({headers:{Accept:'application/json'},cache:'no-store',redirect:'error'}));
  if (scenario === 'unchanged') {
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.shell')?.hidden).toBe(false));
    expect(dispose).not.toHaveBeenCalled(); expect(document.querySelector('input')?.value).toBe('unfinished');
  } else {
    await vi.waitFor(() => expect(document.querySelector('[data-console-recovery]')).not.toBeNull());
    expect(dispose).toHaveBeenCalledTimes(1); expect(document.querySelector('.shell,.identity')).toBeNull();
    expect(document.querySelector('main a')?.getAttribute('href')).toBe(target);
    expect(document.body.textContent).toContain(scenario === 'unavailable' ? '无法确认' : '当前服务账号或管理权限已经改变');
    if (scenario === 'unavailable') expect(document.body.textContent).not.toContain('已经改变');
  }
});

it('ignores a late service authorization result after departure', async () => {
  history.replaceState(null, '', '/me/service-accounts/svc_one?view=keys');
  document.querySelector('main')!.setAttribute('data-service-id','svc_one');
  document.querySelector('main')!.setAttribute('data-service-status','active');
  let resolve!: (response: Response) => void;
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({user:{id:'actor-A',email:'viewer@example.test',role:'user',status:'active'}}))
    .mockReturnValueOnce(new Promise<Response>(done => {resolve=done;}));
  vi.stubGlobal('fetch',fetch); stop = initializeRecovery(vi.fn()); document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); window.dispatchEvent(new PageTransitionEvent('pagehide'));
  resolve(Response.json({service:{id:'svc_one',status:'active'}})); await new Promise(done => setTimeout(done,0));
  expect(document.querySelector('.shell,.identity')).toBeNull(); expect(document.querySelector('[data-console-recovery]')).not.toBeNull();
});

it.each([[503,{error:{code:'unavailable'}}],[200,{user:{id:'actor-A',email:'viewer@example.test'}}]] as const)('treats an unavailable or incomplete human authority read as unknown (%s)', async (status,body) => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(body,{status}))); stop = initializeRecovery(vi.fn()); document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(document.querySelector('[data-console-recovery]')).not.toBeNull());
  expect(document.body.textContent).toContain('无法确认'); expect(document.body.textContent).not.toContain('已经改变');
  expect(document.querySelector('.shell,.identity')).toBeNull();
});

it('never restores a former actor after the same mailbox is reassigned to another stable identity', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({user:{id:'actor-B',email:'viewer@example.test',role:'user',status:'active'}})));
  const dispose=vi.fn(); stop=initializeRecovery(dispose); document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(()=>expect(dispose).toHaveBeenCalledOnce());
  expect(document.querySelector('.shell,.identity,input,[data-one-time-key]')).toBeNull();
  expect(document.querySelector('[data-console-recovery]')).not.toBeNull();
});

it.each(['first','latest'] as const)('only the latest foreground generation can settle privacy, resolving %s first', async first => {
  let visibility:DocumentVisibilityState='visible'; vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility);
  const requests:Array<{resolve:(response:Response)=>void; signal:AbortSignal}>=[];
  const fetch=vi.fn((_url:string,init:RequestInit)=>new Promise<Response>(resolve=>requests.push({resolve,signal:init.signal!})));
  vi.stubGlobal('fetch',fetch); stop=initializeRecovery(vi.fn());
  document.dispatchEvent(new Event('visibilitychange'));
  visibility='hidden'; document.dispatchEvent(new Event('visibilitychange'));
  expect(requests[0].signal.aborted).toBe(true);
  visibility='visible'; document.dispatchEvent(new Event('visibilitychange'));
  expect(fetch).toHaveBeenCalledTimes(2);
  const unchanged=()=>Response.json({user:{id:'actor-A',email:'viewer@example.test',role:'user',status:'active'}});
  if(first==='first') {
    requests[0].resolve(unchanged()); await new Promise(done=>setTimeout(done,0));
    expect(document.documentElement.hasAttribute('data-console-authority-pending')).toBe(true);
    expect(document.querySelector<HTMLElement>('.shell')?.hidden).toBe(true);
    expect(document.querySelector('[data-console-authority-status]')).not.toBeNull();
    requests[1].resolve(Response.json({error:{code:'admin_auth_required'}},{status:403}));
    await vi.waitFor(()=>expect(document.querySelector('.shell')).toBeNull());
  } else {
    requests[1].resolve(unchanged()); await vi.waitFor(()=>expect(document.querySelector<HTMLElement>('.shell')?.hidden).toBe(false));
    requests[0].resolve(Response.json({error:{code:'admin_auth_required'}},{status:403})); await new Promise(done=>setTimeout(done,0));
    expect(document.querySelector('[data-console-recovery]')).toBeNull();
    expect(document.documentElement.hasAttribute('data-console-authority-pending')).toBe(false);
    expect(document.querySelector('input')?.value).toBe('unfinished');
  }
});

it('does not reveal a successful authority read completed while backgrounded', async () => {
  let visibility:DocumentVisibilityState='visible'; vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility);
  let finish!:(response:Response)=>void; vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));
  stop=initializeRecovery(vi.fn()); document.dispatchEvent(new Event('visibilitychange'));
  visibility='hidden'; document.dispatchEvent(new Event('visibilitychange'));
  finish(Response.json({user:{id:'actor-A',email:'viewer@example.test',role:'user',status:'active'}})); await new Promise(done=>setTimeout(done,0));
  expect(document.documentElement.hasAttribute('data-console-authority-pending')).toBe(true);
  expect(document.body.inert).toBe(true); expect(document.querySelector<HTMLElement>('.shell')?.hidden).toBe(true);
});

it('rejects a missing actor ID rather than falling back to a matching mailbox', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({user:{email:'viewer@example.test',role:'user',status:'active'}})));
  stop=initializeRecovery(vi.fn()); document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(()=>expect(document.querySelector('.shell')).toBeNull());
  expect(document.body.textContent).toContain('无法确认');
});

it.each(['navigation','mutation'] as const)('keeps the document privacy boundary across an in-flight %s replacement', async operation => {
  document.body.innerHTML=new DOMParser().parseFromString(dashboardHtml('access','<form method="post" action="/admin/ui/keys"><input name="name" value="private draft"><button type="submit">Create</button></form>'),'text/html').body.innerHTML;
  browserLayout();
  let finishPage!:(response:Response)=>void; let finishMe!:(response:Response)=>void;
  const pageResult=new Promise<Response>(resolve=>{finishPage=resolve;}); const meResult=new Promise<Response>(resolve=>{finishMe=resolve;});
  vi.stubGlobal('fetch',vi.fn((url:string)=>url==='/me'?meResult:pageResult));
  const navigation=createNavigation(()=>{},createDrafts()); const mutations=initializeMutations(navigation);
  const dispose=()=>{mutations();navigation.dispose();}; const recovery=initializeRecovery(dispose); stop=()=>{recovery();dispose();};
  if(operation==='navigation') document.querySelector<HTMLAnchorElement>('#account-link')!.click(); else submit(document.querySelector('form')!);
  document.dispatchEvent(new Event('visibilitychange'));
  const incoming=dashboardHtml('credentials','<section data-late-private>Private replacement</section>')
    .replace('data-dashboard-view="credentials"',`data-dashboard-view="credentials"${operation==='mutation'?' data-dashboard-mutation="key_created"':''}`);
  finishPage(new Response(incoming,{headers:{'Content-Type':'text/html'}}));
  await vi.waitFor(()=>expect(document.querySelector('[data-late-private]')).not.toBeNull());
  expect(document.documentElement.hasAttribute('data-console-authority-pending')).toBe(true);
  expect(document.body.inert).toBe(true); expect(document.querySelector('[data-console-authority-status]')).not.toBeNull();
  finishMe(Response.json({error:{code:'admin_auth_required'}},{status:403}));
  await vi.waitFor(()=>expect(document.querySelector('.shell,[data-late-private],input')).toBeNull());
  expect(document.documentElement.hasAttribute('data-console-authority-pending')).toBe(false);
});

it('discards old drafts before accepting HTML projected for a different actor', async () => {
  document.body.innerHTML=new DOMParser().parseFromString(dashboardHtml('access','<form data-dashboard-draft="person" action="/admin/ui/users"><input name="email" value="unchanged@example.test"></form>'),'text/html').body.innerHTML;
  browserLayout(); const drafts=createDrafts(); const navigation=createNavigation(()=>{},drafts);
  const recovery=initializeRecovery(()=>navigation.dispose()); stop=()=>{recovery();navigation.dispose();};
  const field=document.querySelector('input')!; field.value='private-draft@example.test'; field.dispatchEvent(new Event('input',{bubbles:true}));
  const incoming=dashboardHtml('credentials','<section data-next-actor>Another actor</section>').replace('data-console-actor-id="actor-A"','data-console-actor-id="actor-B"');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(incoming,{headers:{'Content-Type':'text/html'}})));
  document.querySelector<HTMLAnchorElement>('#account-link')!.click();
  await vi.waitFor(()=>expect(document.querySelector('[data-console-recovery]')).not.toBeNull());
  expect(document.querySelector('.shell,input,[data-next-actor]')).toBeNull();
  const fresh=document.createElement('section'); fresh.innerHTML='<form data-dashboard-draft="person" action="/admin/ui/users"><input name="email" value="unchanged@example.test"></form>';
  drafts.restore(fresh); expect(fresh.querySelector('input')?.value).toBe('unchanged@example.test');
});

it.each([['member','confirmed'],['admin','confirmed'],['member','unknown']] as const)('keeps a %s %s write outcome distinct while discarding another actor response', async (area,outcome) => {
  const form='<form method="post" action="'+(area==='member'?'/me/ui/keys':'/admin/ui/keys')+'"><input name="name" value="private draft"><button type="submit">Create</button></form>';
  document.body.innerHTML=new DOMParser().parseFromString(dashboardHtml('access',form),'text/html').body.innerHTML;
  document.body.className=area==='member'?'console-simple':''; browserLayout();
  const navigation=createNavigation(()=>{},createDrafts()); const mutations=area==='member'?initializeMemberMutations():initializeMutations(navigation);
  const dispose=()=>{mutations();navigation.dispose();}; const recovery=initializeRecovery(dispose); stop=()=>{recovery();dispose();};
  const incoming=dashboardHtml('access',outcome==='confirmed'?'<section data-one-time-key>INVALID-DISPLAY-ONLY</section>':'<p>Unrelated response</p>').replace('data-console-actor-id="actor-A"','data-console-actor-id="actor-B"')
    .replace('<body>','<body class="console-simple">').replace('data-dashboard-view="access"','data-dashboard-view="access" data-dashboard-mutation="key_created"');
  const fetch=vi.fn().mockResolvedValue(new Response(incoming,{headers:{'Content-Type':'text/html'}})); vi.stubGlobal('fetch',fetch);
  submit(document.querySelector('form')!);
  await vi.waitFor(()=>expect(document.querySelector('[data-console-recovery]')).not.toBeNull());
  expect(document.querySelector('.shell,input,[data-one-time-key]')).toBeNull();
  expect(document.body.textContent).toContain(outcome==='confirmed'?'服务器已确认':'结果尚未确认');
  expect(document.body.textContent).not.toContain(outcome==='confirmed'?'结果尚未确认':'服务器已确认');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  ['/admin?area=me&view=keys', '/admin?area=me&view=keys&key=second'],
  ['/admin?area=me&view=keys&key=first', '/admin?area=me&view=keys&key=second'],
  ['/admin?area=me&view=keys&key=first', '/admin?area=me&view=keys'],
  ['/me/service-accounts/svc_one?view=keys&key=first', '/me/service-accounts/svc_one?view=keys&key=second']
])('recovers the current scoped read after local selection at %s', (locationTarget, readTarget) => {
  history.replaceState(null, '', locationTarget + '#member-key-inventory');
  document.querySelector<HTMLElement>('main')!.dataset.consoleReadUrl = readTarget;
  stop = initializeRecovery(vi.fn());
  document.dispatchEvent(new CustomEvent('console:actor-changed', {detail: {outcome: 'read', changed: false, reason: 'authority'}}));
  expect(document.querySelector('[data-console-recovery] a')?.getAttribute('href')).toBe(readTarget + '#member-key-inventory');
  expect(document.activeElement?.tagName).toBe('H1');
});

it.each(['https://foreign.invalid/admin?area=me&view=keys', '/me/ui/keys', '/me/service-accounts/foreign?view=keys'])('does not use an unsafe or foreign-scope recovery read %s', readTarget => {
  history.replaceState(null, '', '/admin?area=me&view=keys&key=first');
  document.querySelector<HTMLElement>('main')!.dataset.consoleReadUrl = readTarget;
  stop = initializeRecovery(vi.fn());
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  expect(document.querySelector('[data-console-recovery] a')?.getAttribute('href')).toBe('/admin?area=me&view=keys&key=first');
});

it.each([
  ['/me/ui/keys','/admin?area=me&view=keys&key=created','member'],
  ['/me/service-accounts/svc_one/ui/keys/old/replace','/me/service-accounts/svc_one?view=keys&key=created','member'],
  ['/admin/ui/users/other/status','/admin?view=access&person=other','admin']
])('recovers a native POST result through its scoped GET projection at %s', (posted,target,area) => {
  history.replaceState(null,'',posted);
  const main=document.querySelector<HTMLElement>('main')!;
  if(area==='member') main.querySelector('[data-one-time-key]')!.setAttribute('data-member-return',target);
  else main.dataset.dashboardUrl=target;
  stop=initializeRecovery(vi.fn()); window.dispatchEvent(new PageTransitionEvent('pagehide'));
  expect(document.querySelector('[data-console-recovery] a')?.getAttribute('href')).toBe(target);
  expect(document.querySelector('[data-console-outcome]')?.getAttribute('data-console-outcome')).toBe('confirmed');
  expect(document.querySelector('[data-one-time-key],.shell,.identity')).toBeNull();
});

it.each([
  ['/me/ui/keys','/admin?view=credentials'],
  ['/admin/ui/users/other/status','/admin?area=me&view=keys&key=created'],
  ['/me/service-accounts/svc_one/ui/keys','/me/service-accounts/foreign?view=keys&key=created']
])('does not use a native result GET outside its current scope (%s)', (posted,target) => {
  history.replaceState(null,'',posted);
  document.querySelector<HTMLElement>('main')!.dataset.consoleReadUrl=target;
  stop=initializeRecovery(vi.fn()); window.dispatchEvent(new PageTransitionEvent('pagehide'));
  expect(document.querySelector('[data-console-recovery] a')?.getAttribute('href')).toBe('/');
});

it.each(['member', 'dashboard'])('retains an already unknown %s submission when the next authority read fails', async area => {
  const main = document.querySelector<HTMLElement>('main')!;
  main.dataset[area === 'member' ? 'memberMutationBlocked' : 'dashboardMutationBlocked'] = 'true';
  main.querySelector('[data-one-time-key]')?.remove();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unavailable')));
  stop = initializeRecovery(vi.fn()); document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(document.querySelector('[data-console-recovery]')).not.toBeNull());
  expect(document.body.textContent).toContain('结果尚未确认');
  expect(document.body.textContent).not.toContain('登录已失效');
  expect(document.querySelector('[data-console-recovery]')?.getAttribute('data-recovery-state')).toBe('unavailable');
  expect(document.querySelector('[data-console-outcome]')?.getAttribute('data-console-outcome')).toBe('unknown');
});

it.each(['confirmed', 'rejected'] as const)('retains the documented %s result after its pending wait has ended', async outcome => {
  document.querySelector<HTMLElement>('main')!.dataset.consoleOutcome = outcome;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({error:{code:'admin_auth_required'}}, {status:403})));
  stop = initializeRecovery(vi.fn()); document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(document.querySelector('[data-console-recovery]')).not.toBeNull());
  expect(document.body.textContent).toContain(outcome === 'confirmed' ? '服务器已确认' : '刚才的操作未执行');
  expect(document.body.textContent).not.toContain('可能尚未确认');
  expect(document.querySelector('[data-console-outcome]')?.getAttribute('data-console-outcome')).toBe(outcome);
});
