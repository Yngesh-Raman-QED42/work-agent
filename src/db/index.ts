import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type AppDb = NodePgDatabase<typeof schema>;

/** Satisfied by both the real node-postgres driver and the pglite test driver. */
export type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

interface DbCell {
  db: AppDb;
  pool: Pool;
}

let cell: DbCell | null = null;
let testOverride: AnyDb | null = null;

function ensureInit(): DbCell {
  if (cell) return cell;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (copy .env.example to .env and fill it in)');
  }
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  cell = { db, pool };
  return cell;
}

export function getDb(): AnyDb {
  if (testOverride) return testOverride;
  return ensureInit().db;
}

/** Test-only: point getDb() at an injected (e.g. pglite) database. */
export function setTestDb(db: AnyDb | null): void {
  testOverride = db;
}

export async function closeDb(): Promise<void> {
  if (cell) {
    await cell.pool.end();
    cell = null;
  }
}
