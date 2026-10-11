import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pluginUpdateProposal } from './plugin-update-proposal.mjs';

test('an unchanged marketplace does not open a pull request', () => {
  assert.deepEqual(pluginUpdateProposal({ changed: false, openHeadRefs: [] }), { action: 'skip', reason: 'unchanged' });
  assert.deepEqual(
    pluginUpdateProposal({ changed: false, openHeadRefs: ['automation/plugin-revisions-1-1'] }),
    { action: 'skip', reason: 'unchanged' },
  );
});

test('a changed marketplace opens one review pull request when none is pending', () => {
  assert.deepEqual(
    pluginUpdateProposal({ changed: true, openHeadRefs: ['feature/unrelated'] }),
    { action: 'open', reason: 'changed' },
  );
});

test('a pending automated proposal blocks another pull request', () => {
  assert.deepEqual(
    pluginUpdateProposal({
      changed: true,
      openHeadRefs: ['feature/unrelated', 'automation/plugin-revisions-42-1'],
    }),
    { action: 'skip', reason: 'pending' },
  );
});

test('a missing or malformed proposal list fails visibly', () => {
  assert.throws(() => pluginUpdateProposal({ changed: true, openHeadRefs: undefined }), /unavailable/);
  assert.throws(() => pluginUpdateProposal({ changed: true, openHeadRefs: [1] }), /unavailable/);
  assert.throws(() => pluginUpdateProposal({ changed: 'yes', openHeadRefs: [] }), /boolean/);
});

// The remote seam models creation committing before its response is lost. The
// oracle is the preserved remote branch/PR and a truthful success/failure result,
// not the create command's exit status. Readback may use any equivalent query.
const identity = {
  repository: 'example/relay',
  branch: 'automation/plugin-revisions-42-1',
  sha: 'a'.repeat(40),
};
function remote({ lostResponse = false, rejectCreate = false, readError = false, response } = {}) {
  const state = { branch: identity.sha, proposals: [], creates: 0 };
  const run = (command, args) => {
    assert.equal(command, 'gh');
    if (args[0] === 'pr' && args[1] === 'create') {
      state.creates++;
      assert.equal(args[args.indexOf('--repo') + 1], identity.repository);
      assert.equal(args[args.indexOf('--base') + 1], 'main');
      assert.equal(args[args.indexOf('--head') + 1], identity.branch);
      assert.ok(args.includes('--draft'));
      if (rejectCreate) throw new Error('creation denied');
      state.proposals.push({ state: 'open',
        base: { ref: 'main', repo: { full_name: identity.repository } },
        head: { ref: identity.branch, sha: identity.sha, repo: { full_name: identity.repository } },
      });
      if (lostResponse) throw new Error('response lost after commit');
      return 'https://github.com/example/relay/pull/123';
    }
    if (args[0] === 'api') {
      const query = new URL(args[1], 'https://api.github.com');
      assert.equal(query.pathname, '/repos/example/relay/pulls');
      assert.equal(query.searchParams.get('base'), 'main');
      assert.equal(query.searchParams.get('head'), `example:${identity.branch}`);
      assert.equal(query.searchParams.get('state'), 'open');
      if (readError) throw new Error('read unavailable');
      return response === undefined ? JSON.stringify(state.proposals) : response(state.proposals);
    }
    // Any attempted cleanup or second kind of mutation fails the test.
    assert.fail(`unexpected external mutation: ${args[0]}`);
  };
  return { state, run };
}

import { createPluginUpdateProposal } from './plugin-update-proposal.mjs';

for (const lostResponse of [false, true]) {
  test(`confirmed PR preserves its head when create response ${lostResponse ? 'is lost' : 'succeeds'}`, () => {
    const { state, run } = remote({ lostResponse });
    assert.match(createPluginUpdateProposal({ ...identity, run }), /Confirmed an open review PR/);
    assert.equal(state.branch, identity.sha);
    assert.equal(state.proposals.length, 1);
    assert.equal(state.creates, 1);
  });
}

for (const scenario of [
  { name: 'unavailable readback', readError: true },
  { name: 'malformed readback', response: () => '{' },
  { name: 'no PR after rejection', rejectCreate: true },
  { name: 'no PR visible after successful create', response: () => '[]' },
  { name: 'wrong head ref', response: ([pr]) => JSON.stringify([{ ...pr, head: { ...pr.head, ref: 'another' } }]) },
  { name: 'wrong head SHA', response: ([pr]) => JSON.stringify([{ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }]) },
  { name: 'wrong head repository', response: ([pr]) => JSON.stringify([{ ...pr, head: { ...pr.head, repo: { full_name: 'other/relay' } } }]) },
  { name: 'wrong base ref', response: ([pr]) => JSON.stringify([{ ...pr, base: { ...pr.base, ref: 'release' } }]) },
  { name: 'wrong base repository', response: ([pr]) => JSON.stringify([{ ...pr, base: { ...pr.base, repo: { full_name: 'other/relay' } } }]) },
  { name: 'closed PR', response: ([pr]) => JSON.stringify([{ ...pr, state: 'closed' }]) },
  { name: 'ambiguous PRs', response: ([pr]) => JSON.stringify([pr, pr]) },
]) {
  test(`${scenario.name} fails visibly and preserves the branch without retrying creation`, () => {
    const { state, run } = remote({ lostResponse: true, ...scenario });
    assert.throws(() => createPluginUpdateProposal({ ...identity, run }), /preserved .*Reconcile it before retrying/);
    assert.equal(state.branch, identity.sha);
    assert.equal(state.creates, 1);
    assert.equal(state.proposals.length, scenario.rejectCreate ? 0 : 1);
  });
}

test('the create CLI reconciles a lost response and exits nonzero on unconfirmed readback', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'plugin-proposal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A real child process exercises CLI dispatch and the gh executable seam.
  writeFileSync(join(directory, 'gh'), `#!/usr/bin/env node
if (process.argv[2] === 'pr' && process.argv[3] === 'create') process.exit(1);
if (process.argv[2] !== 'api') process.exit(99);
process.stdout.write(process.env.TEST_READBACK);
`, { mode: 0o755 });
  const proposal = {
    state: 'open', base: { ref: 'main', repo: { full_name: identity.repository } },
    head: { ref: identity.branch, sha: identity.sha, repo: { full_name: identity.repository } },
  };
  for (const [proposals, status] of [[[proposal], 0], [[], 1]]) {
    const result = spawnSync(process.execPath, [new URL('./plugin-update-proposal.mjs', import.meta.url).pathname, 'create'], {
      encoding: 'utf8', env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`,
        GITHUB_REPOSITORY: identity.repository, PLUGIN_UPDATE_BRANCH: identity.branch,
        PLUGIN_UPDATE_SHA: identity.sha, TEST_READBACK: JSON.stringify(proposals),
      },
    });
    assert.equal(result.status, status, result.stderr);
    if (status === 0) assert.match(result.stdout, /Confirmed an open review PR/);
    else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /preserved/);
    }
  }
});
