import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { PGlite } from '@electric-sql/pglite';
import { join } from 'node:path';
import * as schema from '../db/schema.js';

export type TestDb = PgliteDatabase<typeof schema>;

export interface TestDbHandle {
  db: TestDb;
  close: () => Promise<void>;
}

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

/**
 * A fresh in-memory PostgreSQL (PGlite) instance per call, fully migrated.
 * Real Postgres semantics, no external server, no Docker needed to run tests.
 */
export async function createTestDb(): Promise<TestDbHandle> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, close: () => client.close() };
}
