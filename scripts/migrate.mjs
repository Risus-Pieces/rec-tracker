// Applies db/schema.sql to the database in DATABASE_URL.
// Runs before every build, so a deploy always has the tables it needs.
import { readFile } from "node:fs/promises";
import pg from "pg";

// Schema changes go over a direct connection when one is available.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.warn("migrate: DATABASE_URL is not set, skipping.");
  process.exit(0);
}

const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(schema);
  console.log("migrate: schema is up to date.");
} finally {
  await client.end();
}
