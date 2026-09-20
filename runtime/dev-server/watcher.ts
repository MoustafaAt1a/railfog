/**
 * Debounced file watcher for RailFog development server (`rail dev`).
 *
 * Spec references:
 * - PLAT-19: Project file layout (railfog.toml, functions/)
 * - tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md: AC4 (Debounce file events)
 */

export interface WatchEvent {
  path: string;
  kind: "create" | "modify" | "delete";
}

export interface WatchOptions {
  paths: string[];
  debounceMs?: number;
  signal?: AbortSignal;
}

export interface WatcherCallback {
  (events: WatchEvent[]): Promise<void> | void;
}

// spec: tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md — Map Deno.FsEvent.kind to WatchEvent.kind
function normalizeKind(
  kind: Deno.FsEvent["kind"],
): "create" | "modify" | "delete" | null {
  switch (kind) {
    case "create":
      return "create";
    case "modify":
      return "modify";
    case "remove":
      return "delete";
    case "access":
      return null;
    default:
      return "modify";
  }
}

const DEFAULT_DEBOUNCE_MS = 100;

/**
 * Monitors file and directory changes, debouncing consecutive events
 * before triggering the hot reload callback.
 * Spec-anchor: tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md AC4
 */
export class ProjectWatcher {
  private readonly options: WatchOptions;
  private readonly debounceMs: number;
  private fsWatcher: Deno.FsWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEvents: WatchEvent[] = [];
  private stopped = false;
  private callback: WatcherCallback | null = null;

  constructor(options: WatchOptions) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async start(callback: WatcherCallback): Promise<void> {
    if (this.stopped) return;
    this.callback = callback;

    if (this.options.signal) {
      if (this.options.signal.aborted) {
        this.stop();
        return;
      }
      this.options.signal.addEventListener("abort", () => this.stop(), {
        once: true,
      });
    }

    const existingPaths: string[] = [];
    for (const p of this.options.paths) {
      try {
        await Deno.stat(p);
        existingPaths.push(p);
      } catch {
        // Path does not exist yet; skip
      }
    }

    if (existingPaths.length === 0 || this.stopped) {
      return;
    }

    try {
      this.fsWatcher = Deno.watchFs(existingPaths);
    } catch {
      return;
    }

    // Spec-anchor: tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md AC4
    // Debounce loop runs asynchronously in background without blocking start()
    (async () => {
      try {
        const watcher = this.fsWatcher;
        if (!watcher) return;
        for await (const event of watcher) {
          if (this.stopped) break;

          for (const rawPath of event.paths) {
            const kind = normalizeKind(event.kind);
            if (!kind) continue;
            this.pendingEvents.push({ path: rawPath, kind });
          }

          if (this.pendingEvents.length > 0 && !this.stopped) {
            if (this.debounceTimer !== null) {
              clearTimeout(this.debounceTimer);
            }
            this.debounceTimer = setTimeout(async () => {
              if (this.stopped) return;
              const toDispatch = this.pendingEvents.splice(0);
              this.debounceTimer = null;
              if (toDispatch.length > 0 && this.callback && !this.stopped) {
                try {
                  await this.callback(toDispatch);
                } catch (err) {
                  console.error("ProjectWatcher callback error:", err);
                }
              }
            }, this.debounceMs);
          }
        }
      } catch {
        // FsWatcher closed or interrupted
      }
    })();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingEvents = [];
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        // Already closed
      }
      this.fsWatcher = null;
    }
  }
}
