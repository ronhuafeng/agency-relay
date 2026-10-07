/** Retained DOM is bound to a server-projected actor, never to a reusable mailbox.
 * These checks only discard browser state; server session/role checks remain the
 * authority for every read and write. */
export type ConsoleOutcome = 'read' | 'confirmed' | 'rejected' | 'unknown';
/** Only the current task's known write outcome is retained in this document.
 * Fresh GET replacement and document disposal discard it with the task. */
export function recordConsoleOutcome(outcome: Exclude<ConsoleOutcome, 'read'>): void {
  const main = document.querySelector<HTMLElement>('main#content');
  if (main) main.dataset.consoleOutcome = outcome;
}
export function consoleActorId(root: ParentNode = document): string | null {
  return root.querySelector<HTMLElement>('[data-console-actor-id]')?.dataset.consoleActorId || null;
}
export function retainConsoleActor(incoming: Document, outcome: ConsoleOutcome = 'read'): boolean {
  const actor = consoleActorId();
  if (actor && consoleActorId(incoming) === actor) return true;
  document.dispatchEvent(new window.CustomEvent('console:actor-changed', {detail: {outcome, changed: Boolean(actor && consoleActorId(incoming))}}));
  return false;
}
/** A bounded public terminal outcome replaces the private document completely. */
export function endConsoleRuntime(): void {
  document.dispatchEvent(new Event('console:document-ended'));
}
