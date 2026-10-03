import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { toPosix } from "./path-guard.js";

export interface WorkspaceChangeNotice {
  paths: string[];
  mode: "watch" | "poll";
  ts: number;
}

type Listener = (notice: WorkspaceChangeNotice) => void;

/** 机器运行时目录：变更与用户无关，且体量足以让轮询和快照失速。 */
const IGNORED_DIRECTORIES = [".git", ".suduo", ".ccb", "node_modules"];

export interface WorkspaceWatcherOptions {
  debounceMs?: number;
  pollIntervalMs?: number;
  forcePolling?: boolean;
}

export class WorkspaceWatcher {
  private readonly channels = new Map<string, WatchChannel>();

  constructor(private readonly options: WorkspaceWatcherOptions = {}) {}

  subscribe(projectId: string, rootPath: string, listener: Listener): () => void {
    let channel = this.channels.get(projectId);
    if (!channel) {
      channel = new WatchChannel(
        rootPath,
        () => this.channels.delete(projectId),
        this.options,
      );
      this.channels.set(projectId, channel);
    }
    return channel.subscribe(listener);
  }

  close(): void {
    for (const channel of this.channels.values()) {
      channel.close();
    }
    this.channels.clear();
  }
}

class WatchChannel {
  private readonly listeners = new Set<Listener>();
  private readonly changed = new Set<string>();
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private snapshot = new Map<string, number>();
  private mode: "watch" | "poll" = "watch";

  constructor(
    private readonly rootPath: string,
    private readonly onEmpty: () => void,
    private readonly options: WorkspaceWatcherOptions,
  ) {
    if (options.forcePolling) {
      this.startPolling();
    } else {
      this.startWatch();
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.close();
        this.onEmpty();
      }
    };
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private startWatch(): void {
    try {
      this.watcher = watch(
        this.rootPath,
        { recursive: true },
        (_eventType, filename) => {
          this.queue(filename ? toPosix(String(filename)) : "");
        },
      );
      this.watcher.on("error", () => this.startPolling());
    } catch {
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.mode = "poll";
    this.watcher?.close();
    this.watcher = null;
    void scanMtimes(this.rootPath).then((snapshot) => {
      this.snapshot = snapshot;
    });
    this.pollTimer = setInterval(
      () => void this.poll(),
      this.options.pollIntervalMs ?? 2_000,
    );
    this.pollTimer.unref();
  }

  private async poll(): Promise<void> {
    const next = await scanMtimes(this.rootPath);
    const paths = new Set([...this.snapshot.keys(), ...next.keys()]);
    for (const path of paths) {
      if (this.snapshot.get(path) !== next.get(path)) {
        this.queue(path);
      }
    }
    this.snapshot = next;
  }

  private queue(path: string): void {
    if (IGNORED_DIRECTORIES.some((name) => path.startsWith(name + "/"))) {
      return;
    }
    this.changed.add(path);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(
      () => this.flush(),
      this.options.debounceMs ?? 300,
    );
    this.debounceTimer.unref();
  }

  private flush(): void {
    this.debounceTimer = null;
    const notice = {
      paths: [...this.changed].sort(),
      mode: this.mode,
      ts: Date.now(),
    } satisfies WorkspaceChangeNotice;
    this.changed.clear();
    for (const listener of this.listeners) {
      listener(notice);
    }
  }
}

async function scanMtimes(root: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const pending = [root];
  while (pending.length > 0 && result.size < 10_000) {
    const directory = pending.pop();
    if (!directory) {
      break;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.includes(entry.name)) {
        continue;
      }
      const absolutePath = resolve(directory, entry.name);
      const path = toPosix(relative(root, absolutePath));
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile()) {
        try {
          result.set(path, (await stat(absolutePath)).mtimeMs);
        } catch {
          // A concurrent rename is reported on the next poll.
        }
      }
    }
  }
  return result;
}
