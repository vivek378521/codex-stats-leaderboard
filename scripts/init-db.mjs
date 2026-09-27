/**
 * One-time schema creation. The API also runs this DDL lazily on first request,
 * so this script is only needed if you want the table up front.
 *
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run init-db
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));
const schema = await readFile(join(here, "..", "schema.sql"), "utf8");

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("TURSO_DATABASE_URL is not set.");
  process.exit(1);
}

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
await client.executeMultiple(schema);
console.log("Schema applied.");
