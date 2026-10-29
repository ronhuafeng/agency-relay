/** Enhance local disclosure only; native documents keep every task reachable. */
export function initializeCredentialWorkspace(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>("[data-credential-catalog-toggle]").forEach(button => {
    if (button.dataset.disclosureReady) return;
    const catalog = button.closest(".accounts-index")?.querySelector<HTMLElement>(".credential-catalog");
    if (!catalog) return;
    button.dataset.disclosureReady = "true";
    button.hidden = false;
    const setOpen = (open: boolean) => {
      button.setAttribute("aria-expanded", String(open));
      catalog.dataset.catalogExpanded = String(open);
    };
    setOpen(button.dataset.catalogInitialOpen === "true");
    button.addEventListener("click", () => setOpen(button.getAttribute("aria-expanded") !== "true"));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-credential-migration-toggle]").forEach(button => {
    if (button.dataset.disclosureReady) return;
    const task = button.closest(".credential-migration-task");
    const form = task?.querySelector<HTMLFormElement>("form");
    if (!form) return;
    button.dataset.disclosureReady = "true";
    button.hidden = false;
    const heading = task?.querySelector<HTMLElement>("[data-credential-migration-heading]");
    if (heading) heading.hidden = true;
    form.hidden = true;
    button.addEventListener("click", () => {
      form.hidden = !form.hidden;
      button.setAttribute("aria-expanded", String(!form.hidden));
    });
  });
}
