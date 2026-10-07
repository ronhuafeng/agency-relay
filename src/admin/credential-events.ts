import { DurableObject } from "cloudflare:workers";
import { readConsoleSessionPrincipalByHash } from "../auth/console-session";

const MAX_SUBSCRIBERS = 256;
const AUTHORITY_INTERVAL_MS = 60000;
interface Subscriber { sessionHash: string; actorId: string }

/** One low-volume invalidation channel per configured console host. Provider
 * work and secret storage remain in the separate TokenAuthority objects. */
export class CredentialEvents extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const sessionHash = request.headers.get("X-Mini-Session-Hash") ?? "";
    const actor = /^[a-f0-9]{64}$/.test(sessionHash) ? await readConsoleSessionPrincipalByHash(this.env, sessionHash) : null;
    if (actor?.role !== "admin") return new Response(null, { status: 403 });
    if (this.ctx.getWebSockets().length >= MAX_SUBSCRIBERS) return new Response(null, { status: 429 });
    const pair = new WebSocketPair();
    const subscriber: Subscriber = { sessionHash, actorId: actor.id };
    pair[1].serializeAttachment(subscriber);
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "connected" }));
    await this.scheduleAuthorityCheck();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Invalidation is expendable. Reconnect and HTTP reads reconcile lost events. */
  async publish(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      if (await this.authorized(socket)) {
        try { socket.send(JSON.stringify({ type: "credentials-changed" })); }
        catch { this.close(socket, 1011); }
      }
    }
  }

  async alarm(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) await this.authorized(socket);
    await this.scheduleAuthorityCheck();
  }

  async webSocketMessage(socket: WebSocket): Promise<void> {
    // No browser messages can mutate accounts, refresh credentials or publish.
    if (await this.authorized(socket)) this.close(socket, 1008);
  }
  webSocketClose(socket: WebSocket): void { this.close(socket, 1000); }
  webSocketError(socket: WebSocket): void { this.close(socket, 1011); }

  private async authorized(socket: WebSocket): Promise<boolean> {
    try {
      const subscriber = socket.deserializeAttachment() as Subscriber | null;
      if (!subscriber || !/^[a-f0-9]{64}$/.test(subscriber.sessionHash) || typeof subscriber.actorId !== "string") {
        this.close(socket, 4403);
        return false;
      }
      const actor = await readConsoleSessionPrincipalByHash(this.env, subscriber.sessionHash);
      if (actor?.role === "admin" && actor.id === subscriber?.actorId) return true;
      this.close(socket, 4403);
    } catch { this.close(socket, 1011); }
    return false;
  }
  private close(socket: WebSocket, code: number): void {
    try { socket.close(code); } catch { /* Already closed. */ }
  }
  private async scheduleAuthorityCheck(): Promise<void> {
    if (this.ctx.getWebSockets().length) {
      const next = Date.now() + AUTHORITY_INTERVAL_MS;
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || existing > next) await this.ctx.storage.setAlarm(next);
    }
    else await this.ctx.storage.deleteAlarm();
  }
}
