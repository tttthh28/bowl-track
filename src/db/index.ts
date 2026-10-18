import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let _db: Db | null = null;

/** 有 DATABASE_URL 才回傳 DB；否則 null（走 localStorage） */
export function getDb(): Db | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!_db) {
    const sql = neon(url);
    _db = drizzle(sql, { schema });
  }
  return _db;
}

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
