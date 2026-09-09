import { neon } from "@neondatabase/serverless";
import { env, hasDatabase } from "./config.js";

export const sql = env.DATABASE_URL ? neon(env.DATABASE_URL) : null;

export async function databaseHealth(): Promise<"configured" | "not_configured" | "reachable"> {
  if (!sql || !hasDatabase()) return "not_configured";
  await sql`select 1`;
  return "reachable";
}
