import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "PulseFetch — Universal Media Downloader",
  description:
    "Paste a YouTube, TikTok, Instagram, Facebook, Pinterest or Snapchat link. Preview it, then save video, audio and thumbnails to your device.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#050510] text-white antialiased">{children}</body>
    </html>
  );
}
