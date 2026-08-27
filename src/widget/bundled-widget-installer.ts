import {
  putWorkspaceDirectory,
  putWorkspaceFile,
  readWorkspaceDirectory,
} from "../editor/siyuan-api";

export const SECRET_VAULT_WIDGET_NAME = "siyuan-secret-vault-widget";
export const SECRET_VAULT_WIDGET_URL = `/widgets/${SECRET_VAULT_WIDGET_NAME}`;

const TARGET_DIR = `/data/widgets/${SECRET_VAULT_WIDGET_NAME}`;
const BUNDLED_BASE = "bundled-widget";
const REQUIRED_FILES = [
  "index.html",
  "widget.css",
  "widget.js",
  "widget.json",
  "README.md",
] as const;

/**
 * Installs the plugin-owned widget package into data/widgets exactly once.
 *
 * The deployed widget is intentionally independent from the plugin package:
 * document NodeWidget blocks keep rendering their dormant snapshot even when
 * the plugin is disabled or removed. Startup only creates a missing package or
 * fills missing managed files; it never rewrites an already complete widget.
 * This avoids cross-device version ping-pong because data/widgets participates
 * in normal SiYuan data synchronization.
 */
export class BundledWidgetInstaller {
  private ready = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly pluginName: string) {}

  ensureInstalled(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.install().then(() => {
      this.ready = true;
    }).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async install(): Promise<void> {
    const widgetRoot = await readWorkspaceDirectory("/data/widgets");
    const widgetDir = widgetRoot.find(
      (entry) => entry.isDir && entry.name === SECRET_VAULT_WIDGET_NAME,
    );

    if (!widgetDir) {
      await putWorkspaceDirectory(TARGET_DIR);
      await this.copyFiles(REQUIRED_FILES);
      return;
    }

    const installedEntries = await readWorkspaceDirectory(TARGET_DIR);
    const installedNames = new Set(
      installedEntries.filter((entry) => !entry.isDir).map((entry) => entry.name),
    );
    const missing = REQUIRED_FILES.filter((name) => !installedNames.has(name));
    if (missing.length > 0) {
      await this.copyFiles(missing);
    }
  }

  private async copyFiles(files: readonly string[]): Promise<void> {
    // widget.json is written last when installing a fresh/incomplete package so
    // SiYuan never observes a complete manifest before the runtime files exist.
    const ordered = [...files].sort((left, right) => {
      if (left === "widget.json") return 1;
      if (right === "widget.json") return -1;
      return left.localeCompare(right);
    });

    for (const fileName of ordered) {
      const source = `/plugins/${this.pluginName}/${BUNDLED_BASE}/${fileName}`;
      const response = await fetch(source, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`无法读取内置 Secret Vault 挂件文件 ${fileName}: HTTP ${response.status}`);
      }

      const blob = await response.blob();
      await putWorkspaceFile(`${TARGET_DIR}/${fileName}`, blob, fileName);
    }
  }
}
