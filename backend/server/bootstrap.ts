import bcrypt from "bcryptjs";
import { env } from "./config.js";
import { sql } from "./db.js";

export async function bootstrapEnvironmentAdministrator(): Promise<void> {
  if (!sql || !env.ADMIN_EMAIL || (!env.ADMIN_PASSWORD && !env.ADMIN_PASSWORD_HASH)) return;

  const passwordHash = env.ADMIN_PASSWORD_HASH ?? await bcrypt.hash(env.ADMIN_PASSWORD!, 12);
  const now = new Date().toISOString();
  const rows = await sql.query(
    `INSERT INTO users (id, email, phone, full_name, password_hash, kyc_status, created_at, updated_at, is_active)
     VALUES ($1, $2, $3, $4, $5, 'VERIFIED', $6, $6, TRUE)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = CASE WHEN users.password_hash = '' THEN EXCLUDED.password_hash ELSE users.password_hash END,
       updated_at = CASE WHEN users.password_hash = '' THEN EXCLUDED.updated_at ELSE users.updated_at END
     RETURNING id`,
    ["env-admin", env.ADMIN_EMAIL.toLowerCase(), "", "Velo Administrator", passwordHash, now]
  ) as Array<{ id: string }>;
  const userId = rows[0]?.id;
  if (!userId) throw new Error("Unable to bootstrap the environment administrator");

  await sql.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMIN') ON CONFLICT DO NOTHING", [userId]);
  await sql.query("INSERT INTO env (key, value, updated_at) VALUES ('admin_email', $1::jsonb, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", [JSON.stringify(env.ADMIN_EMAIL.toLowerCase()), now]);
  await sql.query("INSERT INTO admin_profiles (id, user_id, created_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING", [`admin-${userId}`, userId, now]);
}
