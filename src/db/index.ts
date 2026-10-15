import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl =
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL ??
  process.env.POSTGRES_PRISMA_URL;

const ssl =
  databaseUrl &&
  (databaseUrl.includes("neon.tech") ||
    databaseUrl.includes("render.com") ||
    process.env.VERCEL)
    ? { rejectUnauthorized: false }
    : undefined;

export const pool =
  databaseUrl
    ? new Pool({
        connectionString: databaseUrl,
        ssl,
      })
    : null;

export const db = pool ? drizzle(pool) : null;

export function requireDb() {
  if (!db) {
    throw new Error("Database is not configured. Set DATABASE_URL or POSTGRES_URL in Vercel environment variables.");
  }
  return db;
}
