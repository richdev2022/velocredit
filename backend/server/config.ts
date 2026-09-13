import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(Number(process.env.PORT ?? 4000)),
  API_HOST: z.string().default("0.0.0.0"),
  API_PUBLIC_URL: z.string().default("http://localhost:4000"),
  API_ORIGIN: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32).optional(),
  JWT_EXPIRES_IN: z.string().default("2h"),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  DOCUMENT_STORAGE_BUCKET: z.string().optional(),
  DOCUMENT_STORAGE_ENDPOINT: z.string().url().optional(),
  DOCUMENT_STORAGE_ACCESS_KEY: z.string().optional(),
  DOCUMENT_STORAGE_SECRET_KEY: z.string().optional(),
  GOOGLE_DRIVE_PARENT_FOLDER_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().optional(),
  GOOGLE_APPS_SCRIPT_UPLOAD_URL: z.string().url().optional(),
  DOCUMENT_MAX_SIZE_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  DOCUMENT_ALLOWED_MIME_TYPES: z.string().default("application/pdf,image/jpeg,image/png"),
  FLUTTERWAVE_BASE_URL: z.string().url().default("https://api.flutterwave.com/v3"),
  FLUTTERWAVE_PUBLIC_KEY: z.string().optional(),
  FLUTTERWAVE_SECRET_KEY: z.string().optional(),
  FLUTTERWAVE_ENCRYPTION_KEY: z.string().optional(),
  FLUTTERWAVE_WEBHOOK_SECRET: z.string().optional(),
  PREMBLY_BASE_URL: z.string().url().default("https://api.prembly.com"),
  PREMBLY_API_KEY: z.string().optional(),
  PREMBLY_BVN_PATH: z.string().startsWith("/").default("/verification/bvn"),
  PREMBLY_NIN_PATH: z.string().startsWith("/").default("/verification/vnin"),
  PREMBLY_BVN_FACE_PATH: z.string().startsWith("/").default("/verification/bvn_w_face"),
  PREMBLY_NIN_FACE_PATH: z.string().startsWith("/").default("/verification/nin_w_face"),
  PREMBLY_ID_SCAN_PATH: z.string().startsWith("/").default("/api/v1/fraud/id-scan/"),
  PREMBLY_FACE_LIVENESS_PATH: z.string().startsWith("/").default("/verification/biometrics/face/liveliness_check"),
  PREMBLY_CREDIT_REPORT_PATH: z.string().startsWith("/").default("/verification/credit_bureau/consumer/advance"),
  PREMBLY_LIVENESS_PATH: z.string().startsWith("/").default("/identitypass/face-verification/liveness"),
  PREMBLY_WEBHOOK_SECRET: z.string().optional(),
  KUDI_BASE_URL: z.string().url().default("https://my.kudisms.net/api"),
  KUDI_API_KEY: z.string().optional(),
  KUDI_SENDER_ID: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default("v21.0"),
  META_WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  META_WHATSAPP_APP_SECRET: z.string().optional(),
  META_WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  META_WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEBUG_SQL: z.enum(["true", "false"]).default("false"),
  LOAN_AUTO_ELIGIBLE_SCORE_MIN: z.coerce.number().int().min(300).max(850).default(650),
  LOAN_AUTO_REVIEW_SCORE_MIN: z.coerce.number().int().min(300).max(850).default(550),
  LOAN_REMINDER_DAYS: z.string().default("7,3,0"),
  BREVO_API_URL: z.string().url().default("https://api.brevo.com/v3"),
  BREVO_API_KEY: z.string().optional(),
  BREVO_SENDER_EMAIL: z.string().email().optional(),
  BREVO_SENDER_NAME: z.string().default("Velo Finance"),
  BRAND_LOGO_URL: z.string().url().optional(),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().default("1VelRf1cdCOWkf0jk6rLyQrkWK8GOaa9e9C6eblR9bdc"),
  GOOGLE_SHEETS_SHEET_NAME: z.string().default("Loan Applications"),
  GOOGLE_SHEETS_BACKUP_SPREADSHEET_ID: z.string().optional(),
  GOOGLE_SHEETS_BACKUP_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  GOOGLE_SHEETS_INGEST_AS_BACKUP_ONLY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
}).superRefine((values, ctx) => {
  if (values.LOAN_AUTO_REVIEW_SCORE_MIN >= values.LOAN_AUTO_ELIGIBLE_SCORE_MIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["LOAN_AUTO_REVIEW_SCORE_MIN"],
      message: "The manual-review threshold must be lower than the automatic-eligibility threshold.",
    });
  }
});

const parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) {
  // Render deploy guard: if env validation fails at startup, die loudly with structured error
  // instead of hanging forever without an open port (causes "Port scan timeout reached").
  // eslint-disable-next-line no-console
  console.error("[FATAL] Environment configuration validation failed:");
  const issues = parsedEnv.error.flatten();
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ fieldErrors: issues.fieldErrors, formErrors: issues.formErrors }, null, 2));
  process.exit(1);
}
export const env = parsedEnv.data;

export function hasDatabase(): boolean {
  return Boolean(env.DATABASE_URL);
}

export function assertProductionSecrets(): void {
  if (env.NODE_ENV !== "production") return;
  if (!env.DATABASE_URL || !env.JWT_SECRET) {
    throw new Error("DATABASE_URL and JWT_SECRET are required in production.");
  }
  if (!env.FLUTTERWAVE_SECRET_KEY || !env.FLUTTERWAVE_WEBHOOK_SECRET) {
    throw new Error("Flutterwave secrets are required in production.");
  }
  if (!env.ADMIN_EMAIL || (!env.ADMIN_PASSWORD && !env.ADMIN_PASSWORD_HASH)) {
    throw new Error("Node admin credentials are required in production.");
  }
  if (!env.PREMBLY_WEBHOOK_SECRET) {
    throw new Error("PREMBLY_WEBHOOK_SECRET is required in production.");
  }
}
