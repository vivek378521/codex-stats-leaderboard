/**
 * One-time schema creation. The API also runs this DDL lazily on first request,
 * so this script is only needed if you want the tables up front.
 *
 *   npm run init-db
 *
 * The DDL is imported from lib/db.js rather than read from schema.sql. Those two
 * used to be separate copies, and they had already drifted: new tables landed in
 * one and not the other, so this script reported "Schema applied" against a
 * database that was missing them. One source, and both paths run identical SQL.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

import { SCHEMA_STATEMENTS } from "../lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("TURSO_DATABASE_URL is not set.");
  process.exit(1);
}

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
await client.executeMultiple(SCHEMA_STATEMENTS.join(";\n"));

// Report what actually landed rather than trusting executeMultiple to have run
// every statement. "Schema applied" used to be printed over a partial result.
const present = await client.execute(
  "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
);
const tables = present.rows.map((row) => String(row.name));
const expected = SCHEMA_STATEMENTS.filter((sql) => /CREATE TABLE/i.test(sql))
  .map((sql) => sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i)[1]);
const missing = expected.filter((name) => !tables.includes(name));

console.log("Schema applied. Tables now present:", tables.join(", ") || "(none)");
if (missing.length) {
  console.error("Missing after applying:", missing.join(", "));
  process.exit(1);
}

// Keep schema.sql as a readable artefact, generated so it cannot drift.
await writeFile(join(repoRoot, "schema.sql"), `${SCHEMA_STATEMENTS.join(";\n")};\n`);
console.log("Wrote schema.sql from the same source.");
