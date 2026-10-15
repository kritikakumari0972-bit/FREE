import { NextResponse } from "next/server";
import { getExtraction, cleanupStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  cleanupStore();
  const { id } = await ctx.params;
  const extraction = getExtraction(id);
  if (!extraction || !extraction.thumbnail) {
    return new NextResponse(null, { status: 404 });
  }
  try {
    const upstream = await fetch(extraction.thumbnail, { redirect: "follow" });
    if (!upstream.ok) return new NextResponse(null, { status: upstream.status });
    const ct = upstream.headers.get("content-type") || "image/jpeg";
    const headers = new Headers();
    headers.set("Content-Type", ct);
    headers.set("Cache-Control", "private, max-age=300");
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
