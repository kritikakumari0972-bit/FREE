export function safeDownloadName(title: string, ext: string) {
  const cleaned = (title || "media")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "media";
  const e = (ext || "bin").replace(/^\./, "").toLowerCase();
  return `${cleaned}.${e}`;
}

export function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
