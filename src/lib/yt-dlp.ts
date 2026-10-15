import { spawn } from "node:child_process";
import { existsSync, chmodSync, createWriteStream, statSync, mkdirSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import ffmpegStatic from "ffmpeg-static";
import type { Extraction, MediaFormat } from "./store";

const YTDLP_RELEASE_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
const TMP_BIN = "/tmp/yt-dlp";

let resolvedBin: string | null = null;
let downloadPromise: Promise<string> | null = null;

function tryChmod(p: string): boolean {
  try {
    chmodSync(p, 0o755);
    return true;
  } catch {
    return false;
  }
}

async function downloadBinary(): Promise<string> {
  if (!downloadPromise) {
    downloadPromise = (async () => {
      const part = `${TMP_BIN}.part-${Date.now()}`;
      const res = await fetch(YTDLP_RELEASE_URL, { redirect: "follow" });
      if (!res.ok || !res.body) {
        downloadPromise = null;
        throw new Error(`Failed to download yt-dlp binary (HTTP ${res.status})`);
      }
      try {
        await pipeline(Readable.fromWeb(res.body as any), createWriteStream(part));
        await rename(part, TMP_BIN);
        tryChmod(TMP_BIN);
        return TMP_BIN;
      } catch (e) {
        downloadPromise = null;
        try {
          await unlink(part);
        } catch {}
        throw e;
      }
    })();
  }
  return downloadPromise;
}

export async function resolveBinary(): Promise<string> {
  if (resolvedBin && existsSync(resolvedBin)) return resolvedBin;

  if (existsSync(TMP_BIN)) {
    tryChmod(TMP_BIN);
    resolvedBin = TMP_BIN;
    return TMP_BIN;
  }

  const candidates = [
    process.env.YTDLP_PATH,
    path.join(process.cwd(), "bin", "yt-dlp"),
    path.join(__dirname, "..", "..", "bin", "yt-dlp"),
    "/usr/local/bin/yt-dlp",
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (existsSync(c)) {
      if (tryChmod(c)) {
        resolvedBin = c;
        return c;
      }
      try {
        const fs = await import("node:fs/promises");
        await fs.copyFile(c, TMP_BIN);
        tryChmod(TMP_BIN);
        resolvedBin = TMP_BIN;
        return TMP_BIN;
      } catch {
        /* try next */
      }
    }
  }

  const bin = await downloadBinary();
  resolvedBin = bin;
  return bin;
}

export function platformFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("youtube") || host.includes("youtu.be")) return "YouTube";
    if (host.includes("tiktok")) return "TikTok";
    if (host.includes("facebook") || host.includes("fb.watch")) return "Facebook";
    if (host.includes("instagram")) return "Instagram";
    if (host.includes("pinterest") || host.includes("pin.it")) return "Pinterest";
    if (host.includes("snapchat")) return "Snapchat";
    if (host.includes("twitter") || host.includes("x.com")) return "X / Twitter";
    if (host.includes("reddit")) return "Reddit";
    if (host.includes("vimeo")) return "Vimeo";
    return host;
  } catch {
    return "Unknown";
  }
}

export function ensureMergedMediaFile(extraction: Extraction, fmt: MediaFormat): string | null {
  if (!fmt || !extraction || !fmt.url) return null;
  if (fmt.type === "image") return null;
  const base = path.join("/tmp", `merge-${extraction.id}-${fmt.ext}`);
  return existsSync(base) ? base : null;
}

export function ensureSingleMediaFile(extraction: Extraction, fmt: MediaFormat): string | null {
  if (!fmt || !extraction || !fmt.url) return null;
  const base = path.join("/tmp", `single-${extraction.id}-${fmt.ext}`);
  return existsSync(base) ? base : null;
}

export function fetchInvidiousExtraction(id: string, url: string): Promise<Extraction | null> {
  return new Promise(async (resolve) => {
    try {
      const endpoint = "https://invidious.nerdvpn.de/api/v1/search?q=" + encodeURIComponent(url);
      const res = await fetch(endpoint, { headers: { Accept: "application/json" } });
      if (!res.ok) return resolve(null);
      const data = await res.json();
      const item = Array.isArray(data) ? data[0] : null;
      if (!item) return resolve(null);

      const fallback: Extraction = {
        id,
        sourceUrl: url,
        title: String(item.title || "Invidious video"),
        thumbnail: item.videoThumbnails?.[0]?.url,
        duration: typeof item.lengthSeconds === "number" ? Number(item.lengthSeconds) : undefined,
        uploader: item.author,
        platform: "YouTube",
        formats: [
          {
            url: `https://www.youtube.com/watch?v=${item.videoId}`,
            ext: "mp4",
            type: "video",
            label: "Fallback video",
          },
        ],
        createdAt: Date.now(),
      };
      resolve(fallback);
    } catch {
      resolve(null);
    }
  });
}

function isStoryboard(f: any): boolean {
  const note = String(f?.format_note || "").toLowerCase();
  if (note.includes("storyboard")) return true;
  if (f?.ext === "mhtml") return true;
  if (f?.protocol === "mhtml") return true;
  return false;
}

function isManifest(f: any): boolean {
  const proto = String(f?.protocol || "").toLowerCase();
  const ext = String(f?.ext || "").toLowerCase();
  const url = String(f?.url || "").toLowerCase();
  if (proto.includes("m3u8") || proto.includes("dash") || proto.includes("mhtml") || proto.includes("rtmp")) return true;
  if (["m3u8", "mpd", "mhtml", "ism", "smil"].includes(ext)) return true;
  if (url.includes(".m3u8") || url.includes(".mpd") || url.includes("/manifest")) return true;
  return false;
}

function classify(f: any): MediaFormat["type"] {
  const v = String(f?.vcodec || "none");
  const a = String(f?.acodec || "none");
  const ext = String(f?.ext || "").toLowerCase();
  const hasV = v !== "none" && v !== "null" && v !== "";
  const hasA = a !== "none" && a !== "null" && a !== "";
  if (hasV && hasA) return "video";
  if (hasV && !hasA) return "video";
  if (!hasV && hasA) return "audio";
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  return "video";
}

function labelFor(f: any): string {
  if (f?.format_note && !isStoryboard(f)) return String(f.format_note);
  if (f?.resolution && f.resolution !== "audio only") return String(f.resolution);
  if (f?.height) return `${f.height}p`;
  if (f?.ext) return String(f.ext).toUpperCase();
  return "media";
}

function toFormat(f: any): MediaFormat | null {
  if (!f || !f.url) return null;
  if (isStoryboard(f)) return null;
  if (isManifest(f)) return null;
  const headers: Record<string, string> = {};
  if (f.http_headers && typeof f.http_headers === "object") {
    for (const [k, v] of Object.entries(f.http_headers)) {
      headers[k] = String(v);
    }
  }
  const rawA = f?.acodec;
  let hasAudio: boolean | undefined;
  if (rawA === "none") hasAudio = false;
  else if (rawA == null || rawA === "null" || rawA === "") hasAudio = undefined;
  else hasAudio = true;
  return {
    formatId: f.format_id ? String(f.format_id) : undefined,
    url: String(f.url),
    ext: String(f.ext || "mp4").toLowerCase(),
    type: classify(f),
    label: labelFor(f),
    width: f.width ? Number(f.width) : undefined,
    height: f.height ? Number(f.height) : undefined,
    filesize: f.filesize || f.filesize_approx ? Number(f.filesize || f.filesize_approx) : undefined,
    hasAudio,
    headers: Object.keys(headers).length ? headers : undefined,
    cookies: f.cookies ? String(f.cookies) : undefined,
  };
}

export async function runYtDlp(url: string, opts?: { cookies?: string; proxy?: string }): Promise<any> {
  const bin = await resolveBinary();
  return new Promise((resolve, reject) => {
    const args = [
      "--js-runtimes",
      "node",
      "--remote-components",
      "ejs:github",
      "--impersonate",
      "chrome",
      "--dump-json",
      "--no-download",
      "--no-playlist",
      "--no-warnings",
    ];
    if (opts?.proxy) args.push("--proxy", opts.proxy);
    if (opts?.cookies) {
      args.push("--add-header", `Cookie:${opts.cookies}`);
    }
    args.push(url);

    const env = { ...process.env };
    const proc = spawn(bin, args, { env });
    let stdout = "";
    let stderr = "";
    const MAX = 50 * 1024 * 1024;
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      reject(new Error("Extraction timed out"));
    }, 150000);

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      if (stdout.length > MAX) {
        try {
          proc.kill("SIGKILL");
        } catch {}
        reject(new Error("Output too large"));
      }
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }
      const lines = stdout.trim().split(/\n/);
      let jsonLine = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t.startsWith("{")) {
          jsonLine = t;
          break;
        }
      }
      if (!jsonLine) {
        reject(new Error("No JSON output from yt-dlp"));
        return;
      }
      try {
        resolve(JSON.parse(jsonLine));
      } catch {
        reject(new Error("Failed to parse yt-dlp output"));
      }
    });
  });
}

export function buildExtraction(id: string, sourceUrl: string, info: any): Extraction {
  const formats: MediaFormat[] = [];
  const seen = new Set<string>();

  const add = (f: any) => {
    const fmt = toFormat(f);
    if (!fmt) return;
    if (seen.has(fmt.url)) return;
    seen.add(fmt.url);
    formats.push(fmt);
  };

  if (Array.isArray(info?.formats)) {
    for (const f of info.formats) add(f);
  }
  if (info?.url) add(info);

  formats.sort((a, b) => {
    const score = (f: MediaFormat) => {
      let s = 0;
      if (f.type === "video") {
        s += 10000;
        if (f.hasAudio !== false) s += 100000;
        if (f.ext === "mp4") s += 2000;
      }
      if (f.type === "image") s += 5000;
      if (f.height) s += f.height;
      if (f.filesize) s += 5000 + Math.min(f.filesize / 100000, 50);
      return s;
    };
    return score(b) - score(a);
  });

  const uniq: MediaFormat[] = [];
  const seen2 = new Set<string>();
  for (const f of formats) {
    if (seen2.has(f.url)) continue;
    seen2.add(f.url);
    uniq.push(f);
  }

  const dedupeBy = (arr: MediaFormat[], keyFn: (f: MediaFormat) => string, limit: number) => {
    const out: MediaFormat[] = [];
    const ks = new Set<string>();
    for (const f of arr) {
      const k = keyFn(f);
      if (ks.has(k)) continue;
      ks.add(k);
      out.push(f);
      if (out.length >= limit) break;
    }
    return out;
  };

  const combined = uniq.filter((f) => f.type === "video" && f.hasAudio !== false);
  const videoOnly = uniq.filter((f) => f.type === "video" && f.hasAudio === false);
  const audios = uniq.filter((f) => f.type === "audio");
  const images = uniq.filter((f) => f.type === "image");

  const seenRes = new Set<string>();
  const take = (arr: MediaFormat[], limit: number) => {
    const out: MediaFormat[] = [];
    for (const f of arr) {
      const k = `${f.height || 0}|${f.ext}`;
      if (seenRes.has(k)) continue;
      seenRes.add(k);
      out.push(f);
      if (out.length >= limit) break;
    }
    return out;
  };

  let videos = [...take(combined, 6), ...take(videoOnly, 3)];
  videos = videos.map((f) => ({
    ...f,
    label: `${f.height ? `${f.height}p` : "Video"} ${f.ext.toUpperCase()}${f.hasAudio === false ? " (no audio)" : ""}`,
  }));

  const audioPicks = dedupeBy(audios, (f) => f.ext, 2).map((f) => ({
    ...f,
    label: `Audio ${f.ext.toUpperCase()}`,
  }));

  const imagePicks = dedupeBy(images, (f) => `${f.width || 0}|${f.ext}`, 4).map((f) => ({
    ...f,
    label: `Image${f.width ? ` ${f.width}px` : ""} ${f.ext.toUpperCase()}`,
  }));

  const thumb = info?.thumbnail ? String(info.thumbnail) : undefined;
  const curated: MediaFormat[] = [...videos, ...audioPicks, ...imagePicks];

  if (thumb) {
    const cleanPath = thumb.split("?")[0].toLowerCase();
    let text = "jpg";
    if (cleanPath.endsWith(".webp")) text = "webp";
    else if (cleanPath.endsWith(".png")) text = "png";
    curated.push({
      url: thumb,
      ext: text,
      type: "image",
      label: `Thumbnail ${text.toUpperCase()}`,
    });
  }

  return {
    id,
    sourceUrl,
    title: String(info?.title || info?.fulltitle || "Untitled media"),
    thumbnail: thumb,
    duration: info?.duration ? Number(info.duration) : undefined,
    uploader: info?.uploader || info?.channel || info?.creator || info?.author || undefined,
    platform: platformFromUrl(sourceUrl),
    formats: curated.length ? curated : uniq,
    createdAt: Date.now(),
  };
}

const INFO_DIR = "/tmp/media-info";

export async function saveInfoJson(id: string, info: any): Promise<string | undefined> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(INFO_DIR, { recursive: true });
    const p = path.join(INFO_DIR, `${id}.json`);
    await writeFile(p, JSON.stringify(info), "utf8");
    return p;
  } catch {
    return undefined;
  }
}

export async function spawnYtDlpStream(infoPath: string, formatId: string, proxy?: string, cookies?: string) {
  const bin = await resolveBinary();
  const args = [
    "--load-info-json",
    infoPath,
    "-f",
    formatId,
    "--impersonate",
    "chrome",
    "--no-warnings",
    "--no-part",
    "--quiet",
    "-o",
    "-",
  ];
  if (proxy) args.push("--proxy", proxy);
  if (cookies) args.push("--add-header", `Cookie:${cookies}`);
  const proc = spawn(bin, args, { env: { ...process.env } });
  return proc;
}

export function buildDirectExtraction(id: string, sourceUrl: string): Extraction {
  const ext = sourceUrl.split("?")[0].split(".").pop()?.toLowerCase() || "mp4";
  const isImage = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext);
  return {
    id,
    sourceUrl,
    title: "Direct media",
    platform: platformFromUrl(sourceUrl),
    formats: [
      {
        url: sourceUrl,
        ext,
        type: isImage ? "image" : "video",
        label: isImage ? "Image" : "Video",
      },
    ],
    createdAt: Date.now(),
  };
}

export function getFfmpegPath(): string {
  return String(ffmpegStatic || "/usr/bin/ffmpeg");
}
