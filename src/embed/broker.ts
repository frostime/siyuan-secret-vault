import { showMessage } from "siyuan";
import type {
  AccessContextId,
  AuthorizationRevocation,
  GroupId,
  SecretId,
} from "../types";
import type { VaultController } from "../vault";
import {
  isSessionConnectMessage,
  isSessionDisconnectMessage,
  isSessionRequest,
  type SessionConnectedMessage,
  type SessionRequest,
  type SessionResponse,
  type SessionRevokedMessage,
} from "./protocol";

export interface ResolvedSessionSource {
  contextId: AccessContextId;
  blockId: string;
}

export interface EmbedSessionHost {
  resolveSessionSource(
    source: Window,
    secretId: SecretId,
  ): Promise<ResolvedSessionSource | null>;
  requestUnlock(contextId: AccessContextId, groupId: GroupId): Promise<boolean>;
}

interface LiveSession {
  id: string;
  secretId: SecretId;
  groupId: GroupId;
  contextId: AccessContextId;
  blockId: string;
  source: Window;
  port: MessagePort;
  closed: boolean;
  tail: Promise<void>;
}

/**
 * Owns explicit live iframe sessions.
 *
 * A document reference is dormant by default. The broker does no discovery,
 * polling, broadcast refresh, or host-ready fan-out. It only accepts a
 * user-triggered one-time handshake, then isolates that iframe on its own
 * MessagePort. Parent-to-child proactive traffic is limited to capability
 * revocation, which destroys plaintext and closes the session.
 */
export class EmbedSessionBroker {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly sessionBySource = new WeakMap<Window, LiveSession>();
  private unsubscribeRevocations: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly vault: VaultController,
    private readonly host: EmbedSessionHost,
    private readonly ready: Promise<void> = Promise.resolve(),
  ) {}

  start(): void {
    window.addEventListener("message", this.onWindowMessage);
    this.unsubscribeRevocations = this.vault.subscribeRevocations(this.revoke);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    window.removeEventListener("message", this.onWindowMessage);
    this.unsubscribeRevocations?.();
    this.unsubscribeRevocations = null;

    for (const session of [...this.sessions.values()]) {
      this.closeSession(session, "plugin-stopping", true);
    }

  }

  private readonly revoke = (revocation: AuthorizationRevocation): void => {
    if (this.disposed) return;

    for (const session of [...this.sessions.values()]) {
      if (!matchesRevocation(session, revocation)) continue;
      this.closeSession(session, revocation.reason, true);
    }
  };

  private readonly onWindowMessage = async (event: MessageEvent): Promise<void> => {
    if (this.disposed || event.origin !== window.location.origin) return;
    if (!isSessionConnectMessage(event.data)) return;

    const source = event.source as Window | null;
    const port = event.ports[0] ?? null;
    if (!source || !port) return;

    port.start();

    try {
      // The listener is installed before Vault initialization settles. A user
      // can therefore click a dormant reference during startup without losing
      // the explicit handshake; there is still no automatic connection.
      await this.ready;
      if (this.disposed) {
        postConnectFailure(port, event.data.sessionId, "秘密库插件已停止");
        return;
      }

      const resolved = await this.host.resolveSessionSource(source, event.data.secretId);
      if (!resolved) {
        postConnectFailure(port, event.data.sessionId, "无法验证当前 Secret 文档引用");
        return;
      }
      if (this.disposed) {
        postConnectFailure(port, event.data.sessionId, "秘密库插件已停止");
        return;
      }

      const secret = this.vault.getSecret(event.data.secretId);
      if (!secret) {
        postConnectFailure(port, event.data.sessionId, "秘密不存在或已被删除");
        return;
      }

      const group = this.vault.getGroup(secret.groupId);
      if (!group) {
        postConnectFailure(port, event.data.sessionId, "秘密所属分组不存在");
        return;
      }

      const initialState = await this.vault.getSecretView(resolved.contextId, secret.id);

      const previous = this.sessionBySource.get(source);
      if (previous && !previous.closed) {
        this.closeSession(previous, "session-replaced", true);
      }
      const duplicateId = this.sessions.get(event.data.sessionId);
      if (duplicateId && !duplicateId.closed) {
        this.closeSession(duplicateId, "session-replaced", true);
      }

      const session: LiveSession = {
        id: event.data.sessionId,
        secretId: secret.id,
        groupId: group.id,
        contextId: resolved.contextId,
        blockId: resolved.blockId,
        source,
        port,
        closed: false,
        tail: Promise.resolve(),
      };

      this.sessions.set(session.id, session);
      this.sessionBySource.set(source, session);
      port.addEventListener("message", (portEvent) => this.enqueuePortMessage(session, portEvent));
      port.addEventListener("messageerror", () => this.closeSession(session, "message-error", false));

      const connected: SessionConnectedMessage = {
        type: "session:connected",
        sessionId: session.id,
        ok: true,
        state: initialState,
      };
      port.postMessage(connected);
    } catch (error) {
      postConnectFailure(
        port,
        event.data.sessionId,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  private enqueuePortMessage(session: LiveSession, event: MessageEvent): void {
    if (session.closed) return;

    if (isSessionDisconnectMessage(event.data)) {
      this.closeSession(session, "client-disconnected", false);
      return;
    }
    if (!isSessionRequest(event.data)) return;

    // Preserve user action order within one iframe. Different live sessions do
    // not block one another; VaultController still owns persistent write order.
    session.tail = session.tail
      .then(() => this.handleRequest(session, event.data))
      .catch((error) => {
        console.warn("[secret-vault] live session request failed", error);
      });
  }

  private async handleRequest(session: LiveSession, request: SessionRequest): Promise<void> {
    if (session.closed) return;

    const respond = (response: Omit<SessionResponse, "type" | "requestId">): void => {
      if (session.closed) return;
      session.port.postMessage({
        type: "response",
        requestId: request.requestId,
        ...response,
      } satisfies SessionResponse);
    };

    try {
      if (request.type === "secret:get-state") {
        respond({
          ok: true,
          state: await this.vault.getSecretView(session.contextId, session.secretId),
        });
        return;
      }

      const secret = this.vault.getSecret(session.secretId);
      if (!secret) {
        respond({ ok: false, error: "秘密不存在或已被删除" });
        return;
      }
      if (secret.groupId !== session.groupId) {
        respond({ ok: false, error: "秘密所属分组已经变化，请重新连接" });
        return;
      }

      const group = this.vault.getGroup(session.groupId);
      if (!group) {
        respond({ ok: false, error: "秘密所属分组不存在" });
        return;
      }

      if (request.type === "secret:lock-group") {
        // Acknowledge the explicit command before revocation closes the port.
        // MessagePort preserves message order, so the client observes response
        // then session:revoked without any refresh or reconnect.
        respond({ ok: true });
        this.vault.lockGroup(session.contextId, group.id);
        return;
      }

      if (!this.vault.isGroupUnlocked(session.contextId, group.id)) {
        const unlocked = await this.host.requestUnlock(session.contextId, group.id);
        if (!unlocked) {
          respond({ ok: false, error: "已取消解锁" });
          return;
        }
      }

      if (session.closed) return;

      switch (request.type) {
        case "secret:reveal":
          respond({
            ok: true,
            state: await this.vault.getSecretView(session.contextId, session.secretId),
          });
          return;

        case "secret:copy":
          await navigator.clipboard.writeText(
            await this.vault.readSecret(session.contextId, session.secretId),
          );
          showMessage(`已复制：${secret.label}`);
          respond({ ok: true });
          return;

        case "secret:update":
          await this.vault.updateSecret(
            session.contextId,
            session.secretId,
            request.data.label,
            request.data.content,
          );
          respond({
            ok: true,
            state: await this.vault.getSecretView(session.contextId, session.secretId),
          });
          return;
      }
    } catch (error) {
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private closeSession(session: LiveSession, reason: string, notify: boolean): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.id);

    if (notify) {
      try {
        session.port.postMessage({
          type: "session:revoked",
          reason,
        } satisfies SessionRevokedMessage);
      } catch {
        // Best effort: the iframe may already have navigated away.
      }
    }

    session.port.close();
  }
}

function postConnectFailure(port: MessagePort, sessionId: string, error: string): void {
  try {
    port.postMessage({
      type: "session:connected",
      sessionId,
      ok: false,
      error,
    } satisfies SessionConnectedMessage);
  } finally {
    port.close();
  }
}

function matchesRevocation(
  session: LiveSession,
  revocation: AuthorizationRevocation,
): boolean {
  switch (revocation.scope) {
    case "all":
      return true;
    case "context":
      return session.contextId === revocation.contextId;
    case "group":
      return session.groupId === revocation.groupId;
    case "context-group":
      return session.contextId === revocation.contextId
        && session.groupId === revocation.groupId;
    case "secret":
      return session.secretId === revocation.secretId;
  }
}
