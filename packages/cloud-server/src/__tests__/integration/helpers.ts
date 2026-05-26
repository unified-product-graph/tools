/**
 * Integration-test harness: a REAL Postgres, not a mocked pool.
 *
 * The mocked unit suite can't see write/trigger paths — which is exactly how
 * three bugs shipped invisibly (#1697 UUID ids, UPG-552 audit log, UPG-553
 * webhook delivery). These helpers stand up a real database so round-trips are
 * exercised end-to-end. See UPG-554.
 *
 * ⚠️ ISOLATION (UPG-555): these tests DROP and recreate the `upg` schema, so
 * they MUST NOT run against the shared dev/MCP database. They default to a
 * dedicated `upg_test` database (auto-created on the same server) and HARD-REFUSE
 * to run against a database named `upg`. Override with `UPG_TEST_DATABASE_URL`,
 * but it may not point at the shared `upg` database.
 *
 * When no Postgres is reachable, `dbAvailable()` returns false and the suites
 * skip via `describe.skipIf` — so the default `npm test` stays green without a DB.
 */
import { Pool } from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '../../../migrations')

/** The shared dev/MCP database name — tests must never touch it. */
const FORBIDDEN_DB = 'upg'

export const TEST_DATABASE_URL =
  process.env.UPG_TEST_DATABASE_URL || 'postgres://upg:upg@localhost:5433/upg_test'

function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '')
}

// Fail fast and loudly if the test URL would clobber the shared database.
const TEST_DB_NAME = databaseName(TEST_DATABASE_URL)
if (TEST_DB_NAME === FORBIDDEN_DB) {
  throw new Error(
    `Refusing to run integration tests against the shared dev/MCP database "${FORBIDDEN_DB}". ` +
      `These tests DROP the schema. Point UPG_TEST_DATABASE_URL at a dedicated database ` +
      `(e.g. .../upg_test).`,
  )
}
if (!/^[a-z_][a-z0-9_]*$/i.test(TEST_DB_NAME)) {
  throw new Error(`Unsafe test database name: "${TEST_DB_NAME}"`)
}

export function makePool(): Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL })
}

/** Create the dedicated test database if it doesn't exist (via the maintenance
 *  `postgres` db on the same server). No-op if it already exists. */
async function ensureTestDatabase(): Promise<void> {
  const adminUrl = new URL(TEST_DATABASE_URL)
  adminUrl.pathname = '/postgres'
  const admin = new Pool({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 1500 })
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB_NAME])
    if (rows.length === 0) {
      // CREATE DATABASE can't be parameterised; TEST_DB_NAME is validated above.
      await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`)
    }
  } finally {
    await admin.end().catch(() => {})
  }
}

/** True iff Postgres is reachable AND the dedicated test database is ready. */
export async function dbAvailable(): Promise<boolean> {
  try {
    await ensureTestDatabase()
    const pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 1500 })
    try {
      await pool.query('SELECT 1')
      return true
    } finally {
      await pool.end().catch(() => {})
    }
  } catch {
    return false
  }
}

/**
 * Drop and recreate the `upg` schema from the migration files, giving each run
 * a clean database. Safe because it runs only against the dedicated test DB
 * (the constructor-time guard above rejects the shared `upg` database).
 */
export async function resetSchema(pool: Pool): Promise<void> {
  // Defence in depth: confirm we're not on the shared database before dropping.
  const { rows } = await pool.query<{ current_database: string }>('SELECT current_database()')
  if (rows[0]?.current_database === FORBIDDEN_DB) {
    throw new Error(`resetSchema refused: connected to the shared database "${FORBIDDEN_DB}"`)
  }
  await pool.query('DROP SCHEMA IF EXISTS upg CASCADE')
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    await pool.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'))
  }
}
