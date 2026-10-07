import assert from 'node:assert/strict';
import test from 'node:test';
import { updateRevisions } from './update-plugin-revisions.mjs';

const oldSha = '1'.repeat(40);
const newSha = '2'.repeat(40);
const fixture = () => ({
  name: 'example',
  plugins: [
    { name: 'root', source: { source: 'url', url: 'https://example.com/plugins.git', ref: 'main', sha: oldSha } },
    { name: 'child', source: { source: 'git-subdir', url: 'https://example.com/plugins.git', path: './plugins/child', ref: 'main', sha: oldSha }, policy: { installation: 'AVAILABLE' } },
  ],
});

test('updates every plugin at one consistent branch revision and preserves metadata', () => {
  const input = fixture();
  let queries = 0;
  const result = updateRevisions(input, (url, ref) => {
    assert.equal(url, 'https://example.com/plugins.git');
    assert.equal(ref, 'main');
    queries++;
    return newSha;
  });
  assert.equal(queries, 1);
  assert.equal(result.changes.length, 2);
  assert.deepEqual(result.marketplace, {
    ...input, plugins: input.plugins.map((plugin) => ({ ...plugin, source: { ...plugin.source, sha: newSha } })),
  });
  assert.deepEqual(input, fixture());
});

test('unchanged branches produce no update', () => {
  assert.deepEqual(updateRevisions(fixture(), () => oldSha).changes, []);
});

test('new Git plugins are included without a separate inventory', () => {
  const input = fixture();
  delete input.plugins[0].source.sha;
  assert.equal(updateRevisions(input, () => oldSha).changes.length, 1);
});

test('an upstream failure leaves the input unchanged rather than accepting a partial update', () => {
  const input = fixture();
  input.plugins[1].source.ref = 'other';
  const before = structuredClone(input);
  assert.throws(() => updateRevisions(input, (_, ref) => {
    if (ref === 'other') throw new Error('upstream unavailable');
    return newSha;
  }), /upstream unavailable/);
  assert.deepEqual(input, before);
});

test('invalid commits, missing branches and unsupported sources fail visibly', () => {
  assert.throws(() => updateRevisions(fixture(), () => 'main'), /invalid upstream commit/);
  const input = fixture();
  delete input.plugins[0].source.ref;
  assert.throws(() => updateRevisions(input), /explicit tracking branch/);
  input.plugins[0].source = { source: 'npm', package: 'example' };
  assert.throws(() => updateRevisions(input), /Git source/);
});

test('embedded credentials are rejected before contacting an upstream', () => {
  const input = fixture();
  input.plugins[0].source.url = 'https://user:secret@example.com/plugins.git';
  assert.throws(() => updateRevisions(input), /credential-free/);
});
