/** Enhancement may download before or after parsing; it must not hold native
 * document completion (including fragment selection) hostage to that download. */
export function afterDocumentParsed(run: () => void, doc: Document = document): void {
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", run, {once: true});
  else run();
}
