# PulseFetch

A Next.js app that lets users paste social media URLs and download or preview media files using `yt-dlp`.

## Features
- Extract media metadata from YouTube, TikTok, Instagram, Facebook, Pinterest, Snapchat, and more
- Preview playable video/audio/image formats in-browser
- Save files directly to the user device
- Runs on Next.js App Router
- Ready for Vercel deployment with a hosted Postgres database

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
```

## Environment variables

```env
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db
```

For Vercel, set `DATABASE_URL` to your hosted Postgres connection string.

## Scripts

```bash
npm run dev
npm run build
npm run lint
npm run typecheck
```

## Notes
- This app uses `yt-dlp` at runtime and downloads the binary automatically if needed.
- The extraction cache is kept in memory and `/tmp` for short-lived sessions.
- For production scale, consider using a shared store such as Vercel Blob, Redis, or Postgres-backed metadata persistence.
