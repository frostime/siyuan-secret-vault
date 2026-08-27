import type { SecretViewState, VaultInvalidation } from "../types";

export const PROTOCOL_NS = "siyuan-secret-vault";
export const PROTOCOL_VERSION = 1;

interface RequestBase {
  ns: typeof PROTOCOL_NS;
  v: typeof PROTOCOL_VERSION;
  requestId: string;
  secretId: string;
}

export type EmbedRequest =
  | (RequestBase & { type: "secret:get-state" })
  | (RequestBase & { type: "secret:reveal" })
  | (RequestBase & { type: "secret:copy" })
  | (RequestBase & { type: "secret:lock-group" })
  | (RequestBase & {
      type: "secret:update";
      data: { label: string; content: string };
    });

export interface EmbedResponse {
  ns: typeof PROTOCOL_NS;
  v: typeof PROTOCOL_VERSION;
  requestId: string;
  type: "response";
  ok: boolean;
  data?: SecretViewState | { content: string };
  error?: string;
}

export interface EmbedInvalidationMessage {
  ns: typeof PROTOCOL_NS;
  v: typeof PROTOCOL_VERSION;
  type: "invalidate";
  invalidation: VaultInvalidation;
}

export interface EmbedHostLifecycleMessage {
  ns: typeof PROTOCOL_NS;
  v: typeof PROTOCOL_VERSION;
  type: "host:ready" | "host:stopping";
}

export interface EmbedResizeMessage {
  ns: typeof PROTOCOL_NS;
  v: typeof PROTOCOL_VERSION;
  type: "embed:resize";
  secretId: string;
  height: number;
}

export function isEmbedRequest(value: unknown): value is EmbedRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;

  if (
    message.ns !== PROTOCOL_NS
    || message.v !== PROTOCOL_VERSION
    || typeof message.requestId !== "string"
    || typeof message.secretId !== "string"
    || typeof message.type !== "string"
  ) {
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

export function isEmbedResizeMessage(value: unknown): value is EmbedResizeMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;

  return message.ns === PROTOCOL_NS
    && message.v === PROTOCOL_VERSION
    && message.type === "embed:resize"
    && typeof message.secretId === "string"
    && typeof message.height === "number"
    && Number.isFinite(message.height);
}
