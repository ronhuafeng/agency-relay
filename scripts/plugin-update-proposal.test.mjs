import assert from 'node:assert/strict';
import test from 'node:test';
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
