import { handleRequest, handleScheduled } from "./router";

export { TokenAuthority } from "./auth/token-authority";
export { CredentialEvents } from "./admin/credential-events";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    handleScheduled(controller, env, ctx);
  }
} satisfies ExportedHandler<Env>;
