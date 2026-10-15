import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

export type MediaFormat = {
  url: string;
  ext: string;
  type: "video" | "audio" | "image";
  label: string;
  width?: number;
  height?: number;
  filesize?: number;
  hasAudio?: boolean;
  headers?: Record<string, string>;
  cookies?: string;
  formatId?: string;
};

export type Extraction = {
  id: string;
  sourceUrl: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  platform?: string;
  formats: MediaFormat[];
  infoPath?: string;
  createdAt: number;
};

const DIR = "/tmp/media-extractions";

const globalStore = globalThis as typeof globalThis & {
  __mediaStore?: Map<string, Extraction>;
};

if (!globalStore.__mediaStore) {
  globalStore.__mediaStore = new Map<string, Extraction>();
}

export const mediaStore = globalStore.__mediaStore;

function ensureDir() {
  try {
    mkdirSync(DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

export function saveExtraction(e: Extraction) {
  mediaStore.set(e.id, e);
  try {
    ensureDir();
    writeFileSync(path.join(DIR, `${e.id}.json`), JSON.stringify(e));
  } catch {
    /* ignore */
  }
}

export function getExtraction(id: string): Extraction | undefined {
  const mem = mediaStore.get(id);
  if (mem) return mem;
  try {
    const p = path.join(DIR, `${id}.json`);
    if (!existsSync(p)) return undefined;
    const e = JSON.parse(readFileSync(p, "utf8")) as Extraction;
    mediaStore.set(id, e);
    return e;
  } catch {
    return undefined;
  }
}

export function cleanupStore() {
  const now = Date.now();
  const ttl = 1000 * 60 * 45;
  for (const [k, v] of mediaStore.entries()) {
    if (now - v.createdAt > ttl) mediaStore.delete(k);
  }
  try {
    ensureDir();
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(DIR, f);
      try {
        const e = JSON.parse(readFileSync(p, "utf8")) as Extraction;
        if (!e.createdAt || now - e.createdAt > ttl) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
