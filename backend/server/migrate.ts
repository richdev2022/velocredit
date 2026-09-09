import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "./db.js";

type TableCheck = { table_name: string | null };

function migrationStatements(source: string): string[] {
  return source
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function ensureDatabaseSchema(): Promise<"created" | "skipped"> {
  if (!sql) return "skipped";
  const file = resolve(process.cwd(), "backend/database/001_initial_schema.sql");
  const source = await readFile(file, "utf8");
  const statements = migrationStatements(source);
  let tableCount = 0;

  for (const statement of statements) {
    const tableMatch = statement.match(
      /^CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i
    );

    if (tableMatch) {
      const tableName = tableMatch[1];
      const result = await sql.query(
        "SELECT to_regclass($1) AS table_name",
        [`public.${tableName}`]
      );
      const firstRow = result[0] as TableCheck | undefined;
      const existed = firstRow?.table_name !== null;
      console.log(
        `Database table ${tableName}: ${existed ? "already exists" : "creating"}`
      );
      tableCount += 1;
    }

    try {
      await sql.query(statement);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "42710") continue;
      throw error;
    }
  }

  console.log(`Database schema ready: ${tableCount} tables checked.`);
  return "created";
}
