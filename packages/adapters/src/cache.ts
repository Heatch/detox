// Tiny ETag/conditional-request store (§7 stage 1): data/cache/<hash>.json
// keyed by URL, holding { etag, body, at }. Adapters may pass it in; misses
// and stale entries just fetch normally.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface CacheEntry {
  etag?: string;
  body: unknown;
  at: string;
}

export class FileCache {
  private dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "cache");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(url: string): string {
    return join(this.dir, createHash("sha256").update(url).digest("hex") + ".json");
  }

  get(url: string): CacheEntry | undefined {
    const p = this.path(url);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as CacheEntry;
    } catch {
      return undefined;
    }
  }

  set(url: string, entry: CacheEntry): void {
    writeFileSync(this.path(url), JSON.stringify(entry));
  }
}
