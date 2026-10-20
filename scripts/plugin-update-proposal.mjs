import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Decide whether a scheduled plugin revision update may open another review PR. */
export function pluginUpdateProposal({ changed, openHeadRefs }) {
  if (typeof changed !== 'boolean') throw new Error('changed must be boolean');
  if (!Array.isArray(openHeadRefs) || openHeadRefs.some((ref) => typeof ref !== 'string')) {
    throw new Error('open proposal list is unavailable');
  }
  if (!changed) return { action: 'skip', reason: 'unchanged' };
  if (openHeadRefs.some((ref) => ref.startsWith('automation/plugin-revisions-'))) {
    return { action: 'skip', reason: 'pending' };
  }
  return { action: 'open', reason: 'changed' };
}

// Report only allowlisted failure facts. gh stderr can contain credentials,
// remote response bodies or arbitrary command output and must never be echoed.
export function proposalFailure(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  let reason = 'unclassified';
  if (/GitHub Actions is not permitted to create or approve pull requests/i.test(stderr)) reason = 'actions-pr-creation-disabled';
  else if (/Resource not accessible by integration/i.test(stderr)) reason = 'resource-not-accessible';
  else if (/Bad credentials|HTTP 401/i.test(stderr)) reason = 'authentication-rejected';
  else if (/API rate limit exceeded|secondary rate limit/i.test(stderr)) reason = 'rate-limited';
  else if (/No commits between/i.test(stderr)) reason = 'no-commits-between-refs';
  else if (error?.code === 'ENOENT') reason = 'gh-unavailable';
  const status = Number.isInteger(error?.status) ? `; exit=${error.status}` : '';
  return `${reason}${status}`;
}

/** Reconcile the remote identity before and after a single create attempt. */
export function createPluginUpdateProposal({ repository, branch, sha, run = execFileSync }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')
    || !/^automation\/plugin-revisions-\d+-\d+$/.test(branch ?? '')
    || !/^[a-f0-9]{40}$/.test(sha ?? '')) {
    throw new Error('invalid plugin proposal identity');
  }
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const head = encodeURIComponent(`${repository.split('/')[0]}:${branch}`);
  const preserved = `preserved ${branch} at ${sha}. Reconcile it before retrying.`;
  const confirmed = `Confirmed an open review PR for ${branch} at ${sha}. Review and approve its required workflows before merge.`;
  const read = () => {
    try {
      const proposals = JSON.parse(run('gh', ['api', `/repos/${repository}/pulls?state=all&head=${head}&per_page=100`], options));
      if (!Array.isArray(proposals)) throw new Error('invalid response');
      return proposals;
    } catch (error) {
      throw new Error(`PR readback failed (${proposalFailure(error)}); ${preserved}`);
    }
  };
  const matches = (proposals) => proposals.length === 1
    && proposals[0]?.state === 'open'
    && proposals[0]?.base?.repo?.full_name === repository
    && proposals[0]?.base?.ref === 'main'
    && proposals[0]?.head?.repo?.full_name === repository
    && proposals[0]?.head?.ref === branch
    && proposals[0]?.head?.sha === sha;
  // A previous invocation may have committed its effect but lost its response.
  // Closed or changed proposals are not permission to create another one.
  const existing = read();
  if (matches(existing)) return confirmed;
  if (existing.length !== 0) throw new Error(`Existing PR identity is not the expected open proposal; ${preserved}`);
  let failure = 'create returned success';
  try {
    run('gh', ['pr', 'create', '--repo', repository, '--draft', '--base', 'main', '--head', branch,
      '--title', 'chore(plugins): update upstream plugin revisions',
      '--body', 'Automated plugin revision proposal for human review. Related: #16, roadmap #15. Do not merge until all required checks on the candidate pass; bot-created PR checks may require Actions approval.'], options);
  } catch (error) {
    failure = `create failed (${proposalFailure(error)})`;
  }
  // A nonzero exit is not proof that GitHub rejected the write. Read back once;
  // neither repeat the creation nor delete a potentially successful PR's head.
  let proposals;
  try {
    proposals = read();
  } catch (error) {
    throw new Error(`${error.message} ${failure}.`);
  }
  if (!matches(proposals)) throw new Error(`Expected PR not confirmed; ${preserved} ${failure}.`);
  return confirmed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === 'create') {
  try {
    process.stdout.write(`${createPluginUpdateProposal({
      repository: process.env.GITHUB_REPOSITORY,
      branch: process.env.PLUGIN_UPDATE_BRANCH,
      sha: process.env.PLUGIN_UPDATE_SHA,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.PLUGIN_UPDATE_CHANGED !== '0' && process.env.PLUGIN_UPDATE_CHANGED !== '1') {
    throw new Error('changed must be boolean');
  }
  if (process.env.PLUGIN_UPDATE_OPEN_REFS === undefined) throw new Error('open proposal list is unavailable');
  const openHeadRefs = process.env.PLUGIN_UPDATE_OPEN_REFS === ''
    ? []
    : process.env.PLUGIN_UPDATE_OPEN_REFS.split('\n').filter((ref) => ref.length > 0);
  const decision = pluginUpdateProposal({
    changed: process.env.PLUGIN_UPDATE_CHANGED === '1',
    openHeadRefs,
  });
  process.stdout.write(`${decision.action}\n`);
}

