import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import { existsSync, statSync, createReadStream } from "node:fs";
import { getExtraction, cleanupStore } from "@/lib/store";
import { ensureMergedMediaFile, ensureSingleMediaFile } from "@/lib/yt-dlp";
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

/**
 * Serves a local media file with full HTTP Range (206) support for <video> seeking
 * and accurate Content-Disposition headers for direct device downloads.
 */
function serveLocalFile(
  filePath: string,
  filename: string,
  ext: string,
  download: boolean,
  req: Request
): Response {
  const stat = statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.get("range");

  if (range && !download) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (isNaN(start) || start >= fileSize || end >= fileSize) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${fileSize}` },
      });
    }

    const chunksize = end - start + 1;
    const stream = createReadStream(filePath, { start, end });
    const headers = new Headers();
    headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Length", String(chunksize));
    headers.set("Content-Type", mimeForExt(ext));
    headers.set("Content-Disposition", "inline");
    headers.set("Cache-Control", "private, max-age=3600");

    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 206,
      headers,
    });
  }

  const stream = createReadStream(filePath);
  const headers = new Headers();
  headers.set("Content-Length", String(fileSize));
  headers.set("Accept-Ranges", "bytes");

  if (download) {
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", contentDisposition(filename));
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Download-Filename", encodeURIComponent(filename));
    headers.set("Cache-Control", "no-store");
  } else {
    headers.set("Content-Type", mimeForExt(ext));
    headers.set("Content-Disposition", "inline");
    headers.set("Cache-Control", "private, max-age=3600");
  }

  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers,
  });
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
  const cachedPath = `/tmp/media-cache/${id}_${index}.${fmt.ext}`;

  // 1. If format needs merging (video + audio), run or await the merge and serve with audio!
  if (fmt.needsMerge) {
    try {
      await ensureMergedMediaFile(extraction, fmt, cachedPath);
      return serveLocalFile(cachedPath, filename, fmt.ext, download, req);
    } catch (e: any) {
      return NextResponse.json(
        { error: e?.message || "Failed to merge audio and video for this format." },
        { status: 500 }
      );
    }
  }

  // 2. If already cached from earlier request, serve directly
  if (existsSync(cachedPath) && statSync(cachedPath).size > 1000) {
    return serveLocalFile(cachedPath, filename, fmt.ext, download, req);
  }

  // 3. For formats that don't need merge (e.g. direct progressive video, audio, image)
  const headers: Record<string, string> = {};
  if (fmt.headers) Object.assign(headers, fmt.headers);
  const cookie = cookieHeader(fmt.cookies || extraction.cookies);
  if (cookie) headers["Cookie"] = cookie;

  const range = download ? null : req.headers.get("range");
  if (range) headers["Range"] = range;

  let upstream: Response | null = null;
  try {
    upstream = await fetch(fmt.url, { headers, redirect: "follow" });
  } catch {
    upstream = null;
  }

  const upstreamCt = (upstream?.headers.get("content-type") || "").toLowerCase();
  const looksLikeManifest =
    upstreamCt.includes("mpegurl") ||
    upstreamCt.includes("dash+xml") ||
    upstreamCt.includes("application/x-mpeg");

  // If upstream rejected (e.g. TikTok CDN 403, or manifest format), download through yt-dlp to cache!
  if (!upstream || (!upstream.ok && upstream.status !== 206) || looksLikeManifest) {
    if (fmt.type === "video" || fmt.type === "audio") {
      try {
        await ensureSingleMediaFile(extraction, fmt, cachedPath);
        return serveLocalFile(cachedPath, filename, fmt.ext, download, req);
      } catch (err: any) {
        return NextResponse.json(
          { error: err?.message || "Failed to cache the media file." },
          { status: 500 }
        );
      }
    }

    const code = upstream ? upstream.status : "network error";
    return NextResponse.json(
      { error: `Source server rejected the request (${code}). Try extracting the link again.` },
      { status: 502 }
    );
  }

  const respHeaders = new Headers();
  if (download) {
    respHeaders.set("Content-Type", "application/octet-stream");
    respHeaders.set("Content-Disposition", contentDisposition(filename));
    respHeaders.set("X-Content-Type-Options", "nosniff");
    respHeaders.set("X-Download-Filename", filename);
    respHeaders.set("Cache-Control", "no-store");
  } else {
    respHeaders.set("Content-Type", mimeForExt(fmt.ext));
    respHeaders.set("Content-Disposition", "inline");
    respHeaders.set("Cache-Control", "private, max-age=3600");
  }

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
