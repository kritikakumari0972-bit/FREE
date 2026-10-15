"use client";

import { useMemo, useState } from "react";

type FormatInfo = {
  index: number;
  type: string;
  label: string;
  ext: string;
  width?: number;
  height?: number;
  filesize?: number;
  hasAudio?: boolean;
  filename?: string;
};

type ExtractResult = {
  id: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  platform?: string;
  sourceUrl: string;
  formats: FormatInfo[];
};

const EXAMPLES: { label: string; url: string; hue: string }[] = [
  { label: "YouTube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", hue: "from-red-500/30 to-red-600/10" },
  { label: "YouTube Shorts", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", hue: "from-rose-500/30 to-orange-500/10" },
  { label: "TikTok", url: "https://www.tiktok.com/@scout2015/video/6718335390845095173", hue: "from-cyan-400/30 to-pink-500/10" },
  { label: "Instagram Reel", url: "https://www.instagram.com/reel/DdUj4ZQg8tQ/", hue: "from-fuchsia-500/30 to-amber-400/10" },
  { label: "Facebook", url: "https://www.facebook.com/watch?v=10153231379946729", hue: "from-blue-500/30 to-indigo-500/10" },
  { label: "Pinterest", url: "https://www.pinterest.com/pin/beautiful-things-video-in-2024--13159023904810854/", hue: "from-red-400/30 to-rose-600/10" },
  { label: "Snapchat", url: "https://www.snapchat.com/@stephensreality/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYdnBwYm1udnJrAaDRBoJjAaDRBnsiAAAAAQ", hue: "from-yellow-300/30 to-amber-500/10" },
];

function formatDuration(sec?: number) {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSize(bytes?: number) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fallbackName(title: string, ext: string) {
  const cleaned = (title || "media")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "media";
  return `${cleaned}.${(ext || "bin").replace(/^\./, "")}`;
}

function triggerAnchorDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function saveToDevice(
  url: string,
  filename: string,
  onProgress: (pct: number | null) => void
) {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  const total = Number(res.headers.get("content-length") || 0);
  const hinted = res.headers.get("X-Download-Filename");
  const name = hinted || filename;

  let blob: Blob;
  if (!res.body) {
    blob = await res.blob();
  } else {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        onProgress(total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null);
      }
    }
    const parts = chunks as unknown as BlobPart[];
    blob = new Blob(parts);
  }

  if (blob.size === 0) throw new Error("Empty file received");
  if (blob.size < 120) {
    const text = await blob.text();
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j?.error) throw new Error(j.error);
    } catch (err) {
      if (err instanceof SyntaxError) {
        blob = new Blob([text]);
      } else {
        throw err;
      }
    }
  }

  const w = window as Window & {
    showSaveFilePicker?: (opts: { suggestedName: string }) => Promise<{
      createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
    }>;
  };

  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      onProgress(100);
      return;
    } catch (err: unknown) {
      const nameErr = err instanceof Error ? err.name : "";
      if (nameErr === "AbortError") return;
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  triggerAnchorDownload(objectUrl, name);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  onProgress(100);
}

type DlState = { key: string; pct: number | null; label: string } | null;

export default function HomePage() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [formatIndex, setFormatIndex] = useState(0);
  const [pasted, setPasted] = useState(false);
  const [dl, setDl] = useState<DlState>(null);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  }

  async function handleExtract(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setResult(null);
    setDl(null);
    if (!url.trim()) {
      setError("Please paste a URL first.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Extraction failed");
      setResult(data);
      setFormatIndex(0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text.trim());
        setPasted(true);
        window.setTimeout(() => setPasted(false), 900);
      }
    } catch {
      setError("Clipboard access denied. Paste manually (Ctrl+V / ⌘V).");
    }
  }

  async function handleDownload(fmt: FormatInfo, key: string) {
    if (!result) return;
    const filename = fmt.filename || fallbackName(result.title, fmt.ext);
    const href = `/api/media/${result.id}?i=${fmt.index}&download=1`;
    setError(null);
    setDl({ key, pct: 0, label: "Starting…" });
    try {
      await saveToDevice(href, filename, (pct) => {
        setDl({
          key,
          pct,
          label: pct == null ? "Saving…" : pct >= 100 ? "Saved" : `Saving ${pct}%`,
        });
      });
      setDl({ key, pct: 100, label: "Saved" });
      showToast(`Saved ${filename} to your device`);
      window.setTimeout(() => setDl(null), 1800);
    } catch (err: unknown) {
      setDl(null);
      setError(err instanceof Error ? err.message : "Download failed");
    }
  }

  const mediaSrc = result ? `/api/media/${result.id}?i=${formatIndex}` : "";
  const selected = result?.formats?.[formatIndex];
  const audioFormat = result?.formats.find((f) => f.type === "audio");
  const thumbFormat = result?.formats.find(
    (f) => f.type === "image" && f.label.toLowerCase().startsWith("thumbnail")
  );

  const downloading = Boolean(dl && dl.pct !== 100);

  const chips = useMemo(
    () =>
      EXAMPLES.map((ex, i) => (
        <button
          key={ex.label}
          type="button"
          style={{ animationDelay: `${i * 50}ms` }}
          onClick={() => setUrl(ex.url)}
          className={`chip-in rounded-full border border-white/10 bg-gradient-to-r ${ex.hue} px-3 py-1.5 text-xs font-medium text-white/90 transition hover:-translate-y-0.5 hover:border-white/30 hover:shadow-lg`}
        >
          {ex.label}
        </button>
      )),
    []
  );

  return (
    <main className="relative min-h-screen overflow-hidden text-white">
      <div className="mesh-bg" />
      <div className="orb left-[8%] top-[18%] h-40 w-40 bg-indigo-500/30" />
      <div className="orb right-[12%] top-[12%] h-52 w-52 bg-fuchsia-500/25" style={{ animationDelay: "1.4s" }} />
      <div className="orb bottom-[10%] left-[40%] h-36 w-36 bg-cyan-400/20" style={{ animationDelay: "2.2s" }} />

      <div className="relative z-10 mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
        <header className="mb-10 text-center fade-up">
          <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-indigo-200">
            <span className="pulse-dot h-2 w-2 rounded-full bg-emerald-400" />
            Live preview · real file save
          </div>
          <h1 className="gradient-title text-4xl font-extrabold tracking-tight sm:text-5xl">
            PulseFetch
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-slate-300 sm:text-base">
            Paste a YouTube, TikTok, Instagram, Facebook, Pinterest or Snapchat link.
            Watch it here, then save video, audio or the thumbnail to your device.
          </p>
        </header>

        <form onSubmit={handleExtract} className="glass fade-up rounded-3xl p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste any post, short, reel, pin or spotlight URL…"
              className="flex-1 rounded-2xl border border-white/10 bg-black/40 px-4 py-3.5 text-white placeholder-slate-500 outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/40"
            />
            <button
              type="button"
              onClick={handlePaste}
              className={`btn-glow rounded-2xl px-5 py-3.5 font-medium ${
                pasted ? "bg-emerald-500 text-white" : "bg-white/10 hover:bg-white/15"
              }`}
            >
              {pasted ? "Pasted" : "Paste"}
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn-glow rounded-2xl bg-gradient-to-r from-indigo-500 via-fuchsia-500 to-cyan-400 px-7 py-3.5 font-semibold text-white shadow-lg shadow-indigo-500/20 disabled:opacity-60"
            >
              {loading ? "Extracting…" : "Fetch"}
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">{chips}</div>
        </form>

        {error && (
          <div className="fade-up mt-4 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        )}

        {loading && (
          <div className="glass fade-up mt-6 overflow-hidden rounded-3xl p-6">
            <div className="flex items-center gap-3 text-slate-200">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-cyan-300" />
              Pulling a playable copy from the source…
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
              <div className="shimmer h-full w-full rounded-full bg-gradient-to-r from-indigo-400 via-fuchsia-400 to-cyan-300" />
            </div>
          </div>
        )}

        {result && (
          <section className="glass fade-up mt-6 rounded-3xl p-4 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row">
              {result.thumbnail && (
                <img
                  src={result.thumbnail}
                  alt="thumbnail"
                  className="h-44 w-full rounded-2xl object-cover shadow-lg shadow-black/40 sm:h-32 sm:w-48"
                />
              )}
              <div className="flex-1">
                <h2 className="text-lg font-semibold leading-snug">{result.title}</h2>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-300">
                  {result.platform && (
                    <span className="rounded-full bg-indigo-500/20 px-2.5 py-0.5 text-indigo-100">
                      {result.platform}
                    </span>
                  )}
                  {result.uploader && <span>{result.uploader}</span>}
                  {result.duration ? <span>{formatDuration(result.duration)}</span> : null}
                </div>
              </div>
            </div>

            <div className="mt-5 overflow-hidden rounded-2xl bg-black ring-1 ring-white/10">
              {selected?.type === "image" ? (
                <img src={mediaSrc} alt={result.title} className="mx-auto max-h-[70vh] w-full object-contain" />
              ) : selected?.type === "audio" ? (
                <div className="p-6">
                  <audio controls src={mediaSrc} className="w-full" />
                </div>
              ) : (
                <video
                  key={mediaSrc}
                  controls
                  playsInline
                  preload="metadata"
                  poster={result.thumbnail}
                  src={mediaSrc}
                  className="mx-auto max-h-[70vh] w-full"
                />
              )}
            </div>

            <div className="mt-5 flex flex-col gap-3">
              {result.formats.length > 1 && (
                <select
                  value={formatIndex}
                  onChange={(e) => setFormatIndex(Number(e.target.value))}
                  className="w-full rounded-2xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white sm:max-w-md"
                >
                  {result.formats.map((f) => (
                    <option key={f.index} value={f.index}>
                      {f.label}
                      {f.filesize ? ` — ${formatSize(f.filesize)}` : ""}
                    </option>
                  ))}
                </select>
              )}

              <div className="flex flex-wrap items-center gap-3">
                {selected && (
                  <SaveButton
                    label={`Save ${selected.label}`}
                    tone="emerald"
                    busy={dl?.key === "main"}
                    pct={dl?.key === "main" ? dl.pct : null}
                    disabled={downloading}
                    onClick={() => handleDownload(selected, "main")}
                  />
                )}
                {audioFormat && (
                  <SaveButton
                    label="Save audio"
                    tone="fuchsia"
                    busy={dl?.key === "audio"}
                    pct={dl?.key === "audio" ? dl.pct : null}
                    disabled={downloading}
                    onClick={() => handleDownload(audioFormat, "audio")}
                  />
                )}
                {thumbFormat && (
                  <SaveButton
                    label="Save thumbnail"
                    tone="sky"
                    busy={dl?.key === "thumb"}
                    pct={dl?.key === "thumb" ? dl.pct : null}
                    disabled={downloading}
                    onClick={() => handleDownload(thumbFormat, "thumb")}
                  />
                )}
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(result.sourceUrl);
                    showToast("Source URL copied");
                  }}
                  className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm transition hover:bg-white/10"
                >
                  Copy source
                </button>
              </div>
              <p className="text-xs text-slate-400">
                Files save to your Downloads folder (or the location you pick in the save dialog).
              </p>
            </div>
          </section>
        )}

        <footer className="mt-12 text-center text-xs text-slate-500">
          For personal use. Respect platform terms and copyright.
        </footer>
      </div>

      {toast && (
        <div
          className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-emerald-400/30 bg-emerald-500/20 px-5 py-2 text-sm text-emerald-50 shadow-xl backdrop-blur-md"
          style={{ animation: "toast-in 0.35s ease both" }}
        >
          {toast}
        </div>
      )}
    </main>
  );
}

function SaveButton({
  label,
  tone,
  busy,
  pct,
  disabled,
  onClick,
}: {
  label: string;
  tone: "emerald" | "fuchsia" | "sky";
  busy: boolean;
  pct: number | null;
  disabled: boolean;
  onClick: () => void;
}) {
  const tones = {
    emerald: "from-emerald-500 to-teal-400 shadow-emerald-500/30",
    fuchsia: "from-fuchsia-500 to-pink-400 shadow-fuchsia-500/30",
    sky: "from-sky-500 to-cyan-400 shadow-sky-500/30",
  };
  const text =
    busy && pct != null && pct >= 100
      ? "Saved"
      : busy && pct != null
        ? `${pct}%`
        : busy
          ? "Saving…"
          : label;

  return (
    <button
      type="button"
      disabled={disabled && !busy}
      onClick={onClick}
      className={`btn-glow relative inline-flex min-w-[9.5rem] items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-r ${tones[tone]} px-5 py-2.5 font-semibold text-white shadow-lg disabled:opacity-50`}
    >
      {busy && (
        <span
          className="progress-fill absolute inset-y-0 left-0 bg-white/25"
          style={{ width: `${pct ?? 35}%` }}
        />
      )}
      <span className="relative z-10">{text}</span>
    </button>
  );
}
