import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  runYtDlp,
  buildExtraction,
  buildDirectExtraction,
  platformFromUrl,
  saveInfoJson,
  fetchInvidiousExtraction,
} from "@/lib/yt-dlp";
import { saveExtraction, cleanupStore } from "@/lib/store";
import { safeDownloadName } from "@/lib/filename";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  cleanupStore();
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = String(body?.url || "").trim();
  const customCookies = body?.cookies ? String(body.cookies).trim() : undefined;
  const customProxy = body?.proxy ? String(body.proxy).trim() : undefined;

  if (!url) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return NextResponse.json({ error: "Only http/https URLs are supported" }, { status: 400 });
  }

  const id = randomUUID();
  const platform = platformFromUrl(url);

  // Direct media URL fallback
  const ext = parsed.pathname.split(".").pop()?.toLowerCase() || "";
  const directMedia = ["mp4", "webm", "mkv", "mov", "mp3", "m4a", "jpg", "jpeg", "png", "webp", "gif"].includes(ext);

  try {
    const info = await runYtDlp(url, { cookies: customCookies, proxy: customProxy });
    const extraction = buildExtraction(id, url, info);
    extraction.infoPath = await saveInfoJson(id, info);
    extraction.cookies = customCookies;
    extraction.proxy = customProxy;

    if (!extraction.formats.length) {
      if (directMedia) {
        const d = buildDirectExtraction(id, url);
        saveExtraction(d);
        return NextResponse.json(toPublic(d));
      }
      return NextResponse.json({ error: "No downloadable media found for this URL" }, { status: 422 });
    }
    saveExtraction(extraction);
    return NextResponse.json(toPublic(extraction));
  } catch (e: any) {
    // If YouTube returned bot verification / sign in required or 429, try Invidious fallback
    if (platform === "YouTube") {
      try {
        const invidiousExtraction = await fetchInvidiousExtraction(id, url);
        if (invidiousExtraction && invidiousExtraction.formats.length) {
          saveExtraction(invidiousExtraction);
          return NextResponse.json(toPublic(invidiousExtraction));
        }
      } catch {}
    }

    if (directMedia) {
      const d = buildDirectExtraction(id, url);
      saveExtraction(d);
      return NextResponse.json(toPublic(d));
    }

    const msg = e?.message || "Extraction failed";
    return NextResponse.json({ error: msg, platform }, { status: 500 });
  }
}

function toPublic(e: any) {
  return {
    id: e.id,
    title: e.title,
    thumbnail: e.thumbnail ? `/api/thumb/${e.id}` : undefined,
    duration: e.duration,
    uploader: e.uploader,
    platform: e.platform,
    sourceUrl: e.sourceUrl,
    formats: e.formats.map((f: any, i: number) => ({
      index: i,
      type: f.type,
      label: f.label,
      ext: f.ext,
      width: f.width,
      height: f.height,
      filesize: f.filesize,
      hasAudio: f.hasAudio,
      filename: safeDownloadName(e.title, f.ext),
    })),
  };
}
