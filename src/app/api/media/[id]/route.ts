import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { getExtraction, cleanupStore } from "@/lib/store";
import { spawnYtDlpStream } from "@/lib/yt-dlp";
import { contentDisposition, safeDownloadName } from "@/lib/filename";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function mimeForExt(ext: string): string {
  const e = ext.toLowerCase();
  const map: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  return map[e] || "application/octet-stream";
}

function cookieHeader(raw?: string) {
  if (!raw) return undefined;
  const attrs = new Set(["domain", "path", "secure", "expires", "httponly", "samesite", "max-age", "partitioned"]);
  const pairs: string[] = [];
  for (const part of String(raw).split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const name = p.slice(0, eq).trim().toLowerCase();
    if (attrs.has(name)) continue;
    pairs.push(p);
  }
  return pairs.length ? pairs.join("; ") : undefined;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  cleanupStore();
  const { id } = await ctx.params;
  const extraction = getExtraction(id);
  if (!extraction) {
    return NextResponse.json({ error: "Not found or expired. Extract the link again." }, { status: 404 });
  }
  const url = new URL(req.url);
  const index = Number(url.searchParams.get("i") || "0");
  const download = url.searchParams.get("download") === "1";
  const fmt = extraction.formats[index] || extraction.formats[0];
  if (!fmt) {
    return NextResponse.json({ error: "No format" }, { status: 404 });
  }

  const filename = safeDownloadName(extraction.title, fmt.ext);
  const headers: Record<string, string> = {};
  if (fmt.headers) Object.assign(headers, fmt.headers);
  const cookie = cookieHeader(fmt.cookies);
  if (cookie) headers["Cookie"] = cookie;
  const range = download ? null : req.headers.get("range");
  if (range) headers["Range"] = range;

  let upstream: Response | null = null;
  try {
    upstream = await fetch(fmt.url, { headers, redirect: "follow" });
  } catch {
    upstream = null;
  }

  const attachHeaders = (base: Headers) => {
    if (download) {
      base.set("Content-Type", "application/octet-stream");
      base.set("Content-Disposition", contentDisposition(filename));
      base.set("X-Content-Type-Options", "nosniff");
      base.set("X-Download-Filename", filename);
      base.set("Cache-Control", "no-store");
    } else {
      const upstreamCt = upstream?.headers.get("content-type") || "";
      const ct =
        upstreamCt && !upstreamCt.includes("text/html") && !upstreamCt.includes("application/json")
          ? upstreamCt
          : mimeForExt(fmt.ext);
      base.set("Content-Type", ct);
      base.set("Content-Disposition", "inline");
      base.set("Cache-Control", "private, max-age=300");
    }
  };

  const upstreamCt = (upstream?.headers.get("content-type") || "").toLowerCase();
  const looksLikeManifest =
    upstreamCt.includes("mpegurl") ||
    upstreamCt.includes("dash+xml") ||
    upstreamCt.includes("application/x-mpeg");

  if (!upstream || (!upstream.ok && upstream.status !== 206) || looksLikeManifest) {
    if (extraction.infoPath && fmt.formatId && existsSync(extraction.infoPath)) {
      try {
        const proc = await spawnYtDlpStream(extraction.infoPath, fmt.formatId);
        const respHeaders = new Headers();
        attachHeaders(respHeaders);
        const body = Readable.toWeb(proc.stdout) as unknown as ReadableStream;
        return new Response(body, { status: 200, headers: respHeaders });
      } catch {
        /* fall through */
      }
    }
    const code = upstream ? upstream.status : "network error";
    return NextResponse.json(
      { error: `Source server rejected the request (${code}). Try extracting the link again.` },
      { status: 502 }
    );
  }

  const respHeaders = new Headers();
  attachHeaders(respHeaders);
  const encoding = upstream.headers.get("content-encoding");
  const cl = upstream.headers.get("content-length");
  if (cl && !encoding) respHeaders.set("Content-Length", cl);
  if (!download) {
    const cr = upstream.headers.get("content-range");
    if (cr) respHeaders.set("Content-Range", cr);
    const ar = upstream.headers.get("accept-ranges");
    respHeaders.set("Accept-Ranges", ar || "bytes");
  }

  return new Response(upstream.body, {
    status: download ? 200 : upstream.status,
    headers: respHeaders,
  });
}
