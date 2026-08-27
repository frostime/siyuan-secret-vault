import { getBlockAttrs, setBlockAttrs } from "./siyuan-api";

const MIN_EMBED_HEIGHT = 42;
const MAX_EMBED_HEIGHT = 420;
const HEIGHT_WRITE_EPSILON = 4;

interface HeightState {
  pendingHeight: number | null;
  running: Promise<void> | null;
}

/**
 * Optional, kernel-owned presentation capability for Secret reference height.
 *
 * This module is intentionally not wired into the 0.5.0 runtime. It contains
 * the complete persistence boundary so re-enabling height later does not
 * require DOM mutation or leak resize policy into session/Vault code.
 */
export class SecretBlockHeightController {
  private readonly stateByBlock = new Map<string, HeightState>();

  applyHeight(blockId: string, requestedHeight: number): Promise<void> {
    const height = clampHeight(requestedHeight);
    let state = this.stateByBlock.get(blockId);

    if (!state) {
      state = { pendingHeight: null, running: null };
      this.stateByBlock.set(blockId, state);
    }

    state.pendingHeight = height;
    if (!state.running) {
      state.running = this.flush(blockId, state).finally(() => {
        state!.running = null;
        if (state!.pendingHeight === null) this.stateByBlock.delete(blockId);
      });
    }

    return state.running;
  }

  private async flush(blockId: string, state: HeightState): Promise<void> {
    while (state.pendingHeight !== null) {
      const height = state.pendingHeight;
      state.pendingHeight = null;
      await this.persist(blockId, height);
    }
  }

  private async persist(blockId: string, height: number): Promise<void> {
    const attrs = await getBlockAttrs(blockId);
    if (attrs["custom-secret-vault"] !== "1") return;

    const currentStyle = attrs.style ?? "";
    const currentHeight = readPixelHeight(currentStyle);
    if (currentHeight !== null && Math.abs(currentHeight - height) < HEIGHT_WRITE_EPSILON) {
      return;
    }

    await setBlockAttrs(blockId, {
      style: mergeStyleHeight(currentStyle, height),
    });
  }
}

export function mergeStyleHeight(style: string, height: number): string {
  const declaration = `height: ${clampHeight(height)}px`;
  const heightPattern = /(^|;)\s*height\s*:[^;]*/gi;

  if (heightPattern.test(style)) {
    heightPattern.lastIndex = 0;
    let replaced = false;
    const merged = style.replace(heightPattern, (_match, separator: string) => {
      if (replaced) return separator;
      replaced = true;
      return `${separator}${separator ? " " : ""}${declaration}`;
    });
    return ensureTrailingSemicolon(merged);
  }

  const prefix = style.trim();
  return prefix
    ? `${ensureTrailingSemicolon(prefix)} ${declaration};`
    : `${declaration};`;
}

function clampHeight(value: number): number {
  return Math.round(Math.max(MIN_EMBED_HEIGHT, Math.min(MAX_EMBED_HEIGHT, value)));
}

function readPixelHeight(style: string): number | null {
  const match = style.match(/(?:^|;)\s*height\s*:\s*(-?\d+(?:\.\d+)?)px(?:\s*!important)?\s*(?=;|$)/i);
  if (!match) return null;

  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function ensureTrailingSemicolon(style: string): string {
  const trimmed = style.trim();
  return !trimmed || trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}
