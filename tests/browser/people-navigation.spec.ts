import { test, expect } from './fixtures';

async function alignedPageSize(page: import('@playwright/test').Page): Promise<void> {
  expect(await page.locator('form.inventory-page-size').evaluate(form => {
    const label = form.querySelector('label')!.getBoundingClientRect();
    const select = form.querySelector('select')!.getBoundingClientRect();
    const button = form.querySelector('button')!.getBoundingClientRect();
    const icon = form.querySelector('[data-slot="native-select-icon"]')!.getBoundingClientRect();
    const centers = [label,select,button].map(rect=>rect.top+rect.height/2);
    return Math.max(...centers)-Math.min(...centers)<=1 && icon.left>=select.left && icon.right<=select.right;
  })).toBe(true);
}

test('category reads retain the displayed collection while pending and keep the exact selected person', async ({page, worker}) => {
  const service = await worker.seedDelegatedService();
  worker.seedLegacyService('unresolved-build');
  await page.goto('/admin?view=access&person=admin&range=30d&page_size=10&page=2');
  const kinds = page.getByRole('navigation', {name:'账号类型', exact:true});
  await expect(kinds.getByRole('link', {name:'全部', exact:true})).toHaveCount(0);
  await expect(kinds.getByRole('link', {name:'成员', exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.locator('.people-table [data-user-id]')).toHaveCount(10);
  await expect(page.locator('.people-table .person-badge')).toHaveCount(0);
  await expect(page.locator('[data-person-detail=admin]')).toBeVisible();
  await page.evaluate(() => { (window as unknown as {peopleDocumentRetained:boolean}).peopleDocumentRetained = true; });
  const original = await page.locator('#people-list').elementHandle();
  const gate = worker.hold({method:'GET',path:'/admin',view:'access'});
  try {
    await kinds.getByRole('link', {name:'管理员',exact:true}).click();
    await gate.entered;
    expect(await original?.evaluate(node=>node.isConnected)).toBe(true);
    await expect(page.locator('.people-table [data-user-id]')).toHaveCount(10);
    await expect(kinds.getByRole('link', {name:'成员',exact:true})).toHaveAttribute('aria-current','page');
  } finally { gate.release(); }
  await expect(kinds.getByRole('link', {name:'管理员',exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.locator('.people-table [data-user-id]')).toHaveCount(2);
  const current = new URL(page.url());
  expect(current.searchParams.get('person')).toBe('admin');
  expect(current.searchParams.get('page_size')).toBe('10');
  expect(current.searchParams.get('range')).toBe('30d');
  expect(current.searchParams.has('page')).toBe(false);
  expect(await page.evaluate(() => Boolean((window as unknown as {peopleDocumentRetained?:boolean}).peopleDocumentRetained))).toBe(true);
  await kinds.getByRole('link', {name:'服务账号',exact:true}).click();
  await expect(page.locator('.people-table [data-user-id]')).toHaveCount(1);
  await expect(page.locator('.people-table [data-user-id]')).toHaveAttribute('data-user-id',service);
  await expect(page.locator('[data-person-detail=admin]')).toBeVisible();
  await kinds.getByRole('link', {name:'待确认',exact:true}).click();
  await expect(page.locator('.people-table [data-user-id]')).toHaveAttribute('data-user-id','unresolved-build');
  expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
});

test('chosen page size survives resize, search and safe draft restoration without changing selection', async ({page, worker}) => {
  await page.goto('/admin?view=access&person=admin&page_size=10&page=2&range=30d');
  await expect(page.locator('.people-table [data-user-id]')).toHaveCount(10);
  await alignedPageSize(page);
  const rows = await page.locator('.people-table [data-user-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-user-id')));
  const location = page.url();
  const reads = worker.requests.length;
  await page.setViewportSize({width:390,height:600});
  await alignedPageSize(page);
  const alignment = await page.locator('.people-table [data-user-id]').first().evaluate(row => {
    const cell = row.querySelector('.people-identity-cell')!.getBoundingClientRect();
    const identity = row.querySelector('.person-identity strong')!.getBoundingClientRect();
    return Math.abs(identity.left - cell.left);
  });
  expect(alignment).toBeLessThanOrEqual(1);
  await expect(page.getByRole('combobox',{name:'每页',exact:true})).toHaveValue('10');
  expect(page.url()).toBe(location);
  expect(await page.locator('.people-table [data-user-id]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-user-id')))).toEqual(rows);
  expect(worker.requests).toHaveLength(reads);
  const create = page.locator('#people-create-root');
  await create.getByRole('button',{name:'添加成员',exact:true}).click();
  await page.locator('#add-person input[name=email]').fill('unfinished@example.test');
  const size = page.getByRole('form',{name:'人员每页数量',exact:true});
  await size.getByRole('combobox',{name:'每页',exact:true}).selectOption('40');
  await size.getByRole('button',{name:'应用',exact:true}).click();
  await expect(page.locator('.people-table [data-user-id]')).toHaveCount(20);
  await expect(page.getByRole('combobox',{name:'每页',exact:true})).toHaveValue('40');
  const current = new URL(page.url());
  expect(current.searchParams.get('person')).toBe('admin');
  expect(current.searchParams.get('range')).toBe('30d');
  expect(current.searchParams.has('page')).toBe(false);
  await create.getByRole('button',{name:'添加成员',exact:true}).click();
  await expect(page.locator('#add-person input[name=email]')).toHaveValue('unfinished@example.test');
  await page.locator('#add-person').getByRole('button',{name:'取消',exact:true}).click();
  const search = page.getByRole('search',{name:'搜索邮箱、名称或 ID',exact:true});
  await search.getByRole('searchbox').fill('person-');
  await search.getByRole('button',{name:'搜索邮箱、名称或 ID',exact:true}).click();
  await expect(page.locator('.people-table [data-user-id]')).toHaveCount(18);
  expect(new URL(page.url()).searchParams.get('page_size')).toBe('40');
  await expect(page.locator('[data-person-detail=admin]')).toBeVisible();
  await page.getByRole('navigation',{name:'账号类型',exact:true}).getByRole('link',{name:'管理员',exact:true}).click();
  await expect(page.locator('.people-table [data-user-id]')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('q')).toBe('person-');
  expect(new URL(page.url()).searchParams.get('page_size')).toBe('40');
  await expect(page.locator('[data-person-detail=admin]')).toBeVisible();
  expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
});

test.describe('native people search and pagination', () => {
  test.use({script:false});
  test('category and page size controls use GET, reset the page and retain exact query context', async ({page, worker}) => {
    await page.goto('/admin?view=access&person=admin&range=30d&q=example&page_size=10&page=2');
    await expect(page.locator('.people-table [data-user-id]')).toHaveCount(10);
    await page.getByRole('navigation',{name:'人员分页',exact:true}).getByRole('link',{name:'上一页',exact:true}).click();
    await expect(page.locator('.people-table [data-user-id]')).toHaveCount(10);
    expect(new URL(page.url()).searchParams.has('page')).toBe(false);
    await page.getByRole('navigation',{name:'账号类型',exact:true}).getByRole('link',{name:'管理员',exact:true}).click();
    await expect(page.locator('.people-table [data-user-id]')).toHaveCount(2);
    const size = page.getByRole('form',{name:'人员每页数量',exact:true});
    await size.getByRole('combobox',{name:'每页',exact:true}).selectOption('20');
    await size.getByRole('button',{name:'应用',exact:true}).click();
    await expect(page.locator('.people-table [data-user-id]')).toHaveCount(2);
    const current = new URL(page.url());
    expect(current.searchParams.get('kind')).toBe('admin');
    expect(current.searchParams.get('page_size')).toBe('20');
    expect(current.searchParams.get('q')).toBe('example');
    expect(current.searchParams.get('person')).toBe('admin');
    expect(current.searchParams.get('range')).toBe('30d');
    expect(current.searchParams.has('page')).toBe(false);
    await expect(page.locator('[data-person-detail=admin]')).toBeVisible();
    expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
  });
});
