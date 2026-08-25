export const PROTOCOL_NS = "siyuan-secret-vault";
export const PROTOCOL_VERSION = 1;

export type EmbedRequestType =
  | "secret:get-state"
  | "secret:reveal"
  | "secret:copy"
  | "secret:lock-group"
  | "secret:update";

export interface EmbedRequest {
  ns: typeof PROTOCOL_NS;
  v: typeof PROTOCOL_VERSION;
  requestId: string;
  type: EmbedRequestType;
  secretId: string;
  data?: {
    label?: string;
    content?: string;
  };
}

export interface EmbedResponse {
  ns: typeof PROTOCOL_NS;
  v: typeof PROTOCOL_VERSION;
  requestId?: string;
  type: "response" | "invalidate";
  ok: boolean;
  data?: unknown;
  error?: string;
}

const REQUEST_TYPES = new Set<EmbedRequestType>([
  "secret:get-state",
  "secret:reveal",
  "secret:copy",
  "secret:lock-group",
  "secret:update",
]);

export function isEmbedRequest(value: unknown): value is EmbedRequest {
  if (!value || typeof value !== "object") return false;
  const msg = value as Partial<EmbedRequest>;
  return msg.ns === PROTOCOL_NS
    && msg.v === PROTOCOL_VERSION
    && typeof msg.requestId === "string"
    && typeof msg.secretId === "string"
    && typeof msg.type === "string"
    && REQUEST_TYPES.has(msg.type as EmbedRequestType);
}
