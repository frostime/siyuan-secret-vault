import type { SecretViewState } from "../types";

export const PROTOCOL_NS = "siyuan-secret-vault";
export const PROTOCOL_VERSION = 2;

/** One-time same-origin handshake sent only after the user opens a live embed. */
export interface SessionConnectMessage {
  ns: typeof PROTOCOL_NS;
  v: typeof PROTOCOL_VERSION;
  type: "session:connect";
  sessionId: string;
  secretId: string;
}

export interface SessionConnectedMessage {
  type: "session:connected";
  sessionId: string;
  ok: boolean;
  state?: SecretViewState;
  error?: string;
}

interface SessionRequestBase {
  type:
    | "secret:get-state"
    | "secret:reveal"
    | "secret:copy"
    | "secret:lock-group"
    | "secret:update";
  requestId: string;
}

export type SessionRequest =
  | (SessionRequestBase & { type: "secret:get-state" })
  | (SessionRequestBase & { type: "secret:reveal" })
  | (SessionRequestBase & { type: "secret:copy" })
  | (SessionRequestBase & { type: "secret:lock-group" })
  | (SessionRequestBase & {
      type: "secret:update";
      data: { label: string; content: string };
    });

export interface SessionResponse {
  type: "response";
  requestId: string;
  ok: boolean;
  state?: SecretViewState;
  error?: string;
}

export interface SessionRevokedMessage {
  type: "session:revoked";
  reason: string;
}

export interface SessionDisconnectMessage {
  type: "session:disconnect";
}

export type SessionPortMessage =
  | SessionConnectedMessage
  | SessionRequest
  | SessionResponse
  | SessionRevokedMessage
  | SessionDisconnectMessage;

export function isSessionConnectMessage(value: unknown): value is SessionConnectMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;

  return message.ns === PROTOCOL_NS
    && message.v === PROTOCOL_VERSION
    && message.type === "session:connect"
    && typeof message.sessionId === "string"
    && typeof message.secretId === "string";
}

export function isSessionRequest(value: unknown): value is SessionRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;

  if (typeof message.requestId !== "string" || typeof message.type !== "string") {
    return false;
  }

  switch (message.type) {
    case "secret:get-state":
    case "secret:reveal":
    case "secret:copy":
    case "secret:lock-group":
      return true;

    case "secret:update": {
      if (!message.data || typeof message.data !== "object") return false;
      const data = message.data as Record<string, unknown>;
      return typeof data.label === "string" && typeof data.content === "string";
    }

    default:
      return false;
  }
}

export function isSessionDisconnectMessage(value: unknown): value is SessionDisconnectMessage {
  return Boolean(
    value
    && typeof value === "object"
    && (value as Record<string, unknown>).type === "session:disconnect",
  );
}
