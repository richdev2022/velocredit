import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "./db.js";

function migrationStatements(source: string): string[] {
  return source
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function ensureDatabaseSchema(): Promise<"created" | "skipped"> {
  if (!sql) return "skipped";
  const file = resolve(process.cwd(), "database/001_initial_schema.sql");
  const source = await readFile(file, "utf8");
  for (const statement of migrationStatements(source)) {
    try {
      await sql.query(statement);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "42710") continue;
      throw error;
    }
  }
  return "created";
}
