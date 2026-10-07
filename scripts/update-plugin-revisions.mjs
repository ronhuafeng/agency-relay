import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const marketplacePath = '.agents/plugins/marketplace.json';
const commitPattern = /^[0-9a-f]{40}$/;

function resolveHead(url, ref) {
  const branch = `refs/heads/${ref}`;
  const output = execFileSync('git', ['ls-remote', '--exit-code', '--heads', '--', url, branch], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const matches = output.trim().split('\n').map((line) => line.split(/\s+/))
    .filter(([, name]) => name === branch);
  if (matches.length !== 1) throw new Error(`Cannot resolve ${url} ${branch}`);
  return matches[0][0];
}

export function updateRevisions(marketplace, resolve = resolveHead) {
  if (!Array.isArray(marketplace.plugins)) throw new Error('Missing marketplace plugins');
  const updated = structuredClone(marketplace);
  const heads = new Map();
  const changes = [];
  for (const plugin of updated.plugins) {
    const source = plugin.source;
    if (!['url', 'git-subdir'].includes(source?.source) || !source.ref) {
      throw new Error(`${plugin.name}: expected a Git source with an explicit tracking branch`);
    }
    const url = new URL(source.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`${plugin.name}: expected a credential-free HTTPS Git URL`);
    }
    const key = JSON.stringify([source.url, source.ref]);
    if (!heads.has(key)) heads.set(key, resolve(source.url, source.ref));
    const sha = heads.get(key);
    if (!commitPattern.test(sha)) throw new Error(`${plugin.name}: invalid upstream commit`);
    if (source.sha !== sha) {
      changes.push({ name: plugin.name, before: source.sha ?? null, after: sha });
      source.sha = sha;
    }
  }
  return { marketplace: updated, changes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = updateRevisions(JSON.parse(readFileSync(marketplacePath, 'utf8')));
  if (result.changes.length) {
    writeFileSync(marketplacePath, `${JSON.stringify(result.marketplace, null, 2)}\n`);
  }
  console.log(JSON.stringify({ changes: result.changes }, null, 2));
}
