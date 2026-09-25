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

const MIGRATION_FILES = [
  "001_initial_schema.sql",
  "002_add_missing_columns.sql",
  "003_harden_required_defaults.sql",
  "004_align_profiles_and_documents.sql",
  "005_unique_loan_application_reference.sql",
  "006_withdrawal_idempotency.sql",
  "007_disbursement_idempotency.sql",
  "008_loan_product_full_config.sql",
];

export async function ensureDatabaseSchema(): Promise<"created" | "skipped"> {
  if (!sql) return "skipped";
  let totalAlterations = 0;
  for (const migrationFile of MIGRATION_FILES) {
    const file = resolve(process.cwd(), "backend/database", migrationFile);
    const source = await readFile(file, "utf8");
    const statements = migrationStatements(source);
    let migrationCount = 0;

    for (const statement of statements) {
      const tableMatch = statement.match(
        /^CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i
      );
      const alterMatch = statement.match(
        /^ALTER TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/i
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
          `[${migrationFile}] Database table ${tableName}: ${existed ? "already exists" : "creating"}`
        );
        migrationCount += 1;
      } else if (alterMatch) {
        const tableName = alterMatch[1];
        console.log(`[${migrationFile}] ALTER TABLE ${tableName} (additive)`);
        migrationCount += 1;
      }

      try {
        await sql.query(statement);
      } catch (error) {
        const duplicateObject =
          typeof error === "object" && error !== null && "code" in error && (
            error.code === "42710" || // object already exists
            error.code === "42701"    // column already exists
          );
        if (duplicateObject) continue;
        throw error;
      }
    }
    console.log(`[${migrationFile}] Done (${migrationCount} statements).`);
    totalAlterations += migrationCount;
  }

  console.log(`Database schema ready: ${totalAlterations} migration statements applied.`);
  return "created";
}
