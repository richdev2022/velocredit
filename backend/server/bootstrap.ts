import bcrypt from "bcryptjs";
import { env } from "./config.js";
import { sql } from "./db.js";

const databaseSettingKeys = new Set([
  "NODE_ENV", "API_PORT", "API_HOST", "API_PUBLIC_URL", "API_ORIGIN", "DOCUMENT_MAX_SIZE_BYTES", "DOCUMENT_ALLOWED_MIME_TYPES",
  "FLUTTERWAVE_BASE_URL", "PREMBLY_BASE_URL", "PREMBLY_BVN_PATH", "PREMBLY_NIN_PATH", "PREMBLY_BVN_FACE_PATH", "PREMBLY_NIN_FACE_PATH",
  "PREMBLY_ID_SCAN_PATH", "PREMBLY_FACE_LIVENESS_PATH", "PREMBLY_CREDIT_REPORT_PATH", "KUDI_BASE_URL", "KUDI_SENDER_ID", "META_GRAPH_API_VERSION",
  "OTP_TTL_SECONDS", "OTP_RESEND_COOLDOWN_SECONDS", "OTP_MAX_ATTEMPTS", "LOG_LEVEL", "DEBUG_SQL", "LOAN_AUTO_ELIGIBLE_SCORE_MIN",
  "LOAN_AUTO_REVIEW_SCORE_MIN", "LOAN_REMINDER_DAYS", "BREVO_API_URL", "BREVO_SENDER_EMAIL", "BREVO_SENDER_NAME", "BRAND_LOGO_URL",
  "GOOGLE_SHEETS_SPREADSHEET_ID", "GOOGLE_SHEETS_SHEET_NAME", "GOOGLE_SHEETS_BACKUP_SPREADSHEET_ID", "GOOGLE_SHEETS_BACKUP_ENABLED",
  "GOOGLE_SHEETS_INGEST_AS_BACKUP_ONLY",
]);

export async function bootstrapEnvironmentAdministrator(): Promise<void> {
  if (!sql) return;

  const now = new Date().toISOString();
  const settings = Object.entries(env)
    .filter(([key]) => databaseSettingKeys.has(key))
    .map(([key, value]) => [key.toLowerCase(), JSON.stringify(value), now]);
  if (settings.length) {
    const placeholders = settings.map((_, index) => `($${index * 3 + 1}, $${index * 3 + 2}::jsonb, $${index * 3 + 3})`).join(", ");
    await sql.query(`INSERT INTO env (key, value, updated_at) VALUES ${placeholders} ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, settings.flat());
  }
  if (!env.ADMIN_EMAIL || (!env.ADMIN_PASSWORD && !env.ADMIN_PASSWORD_HASH)) return;

  const passwordHash = env.ADMIN_PASSWORD_HASH || await bcrypt.hash(env.ADMIN_PASSWORD!, 12);
  const rows = await sql.query(
    `INSERT INTO users (id, email, phone, full_name, password_hash, kyc_status, created_at, updated_at, is_active)
     VALUES ($1, $2, $3, $4, $5, 'VERIFIED', $6, $6, TRUE)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = EXCLUDED.updated_at, is_active = TRUE
     RETURNING id`,
    ["env-admin", env.ADMIN_EMAIL.toLowerCase(), "", "Velo Administrator", passwordHash, now]
  ) as Array<{ id: string }>;
  const userId = rows[0]?.id;
  if (!userId) throw new Error("Unable to bootstrap the environment administrator");

  await sql.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMIN') ON CONFLICT DO NOTHING", [userId]);
  await sql.query("INSERT INTO env (key, value, updated_at) VALUES ('admin_email', $1::jsonb, $2), ('admin_password_hash', $3::jsonb, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", [JSON.stringify(env.ADMIN_EMAIL.toLowerCase()), now, JSON.stringify(passwordHash)]);
  await sql.query("INSERT INTO admin_profiles (id, user_id, password_hash, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash", [`admin-${userId}`, userId, passwordHash, now]);
}
