import { pathToFileURL } from 'node:url';

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
