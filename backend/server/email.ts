import { env } from "./config.js";

function escapeHtml(value: unknown): string { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character); }
export type ReminderKind = "SEVEN_DAYS" | "THREE_DAYS" | "DUE_TODAY" | "OVERDUE";

export function loanReminderEmail(input: { borrowerName: string; amountNaira: number; dueDate: string; outstandingNaira: number; lateFee: string; kind: ReminderKind }): { subject: string; html: string } {
  const titles: Record<ReminderKind, string> = { SEVEN_DAYS: "Your Velo repayment is due in 7 days", THREE_DAYS: "Your Velo repayment is due in 3 days", DUE_TODAY: "Your Velo repayment is due today", OVERDUE: "Your Velo repayment is overdue" };
  const accent = input.kind === "OVERDUE" ? "#dc2626" : "#2196f3";
  const logo = env.BRAND_LOGO_URL ? `<img src="${escapeHtml(env.BRAND_LOGO_URL)}" alt="Velo Finance" style="height:42px;width:auto" />` : `<strong style="font-size:24px;color:#17243d">VELO</strong>`;
  return { subject: titles[input.kind], html: `<!doctype html><html><body style="margin:0;background:#f4f8fc;font-family:Arial,sans-serif;color:#17243d"><div style="max-width:600px;margin:32px auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 28px rgba(15,35,65,.08)"><div style="padding:26px 30px;border-bottom:1px solid #e5edf5">${logo}</div><div style="padding:30px"><div style="display:inline-block;padding:7px 11px;border-radius:999px;background:${accent}18;color:${accent};font-size:12px;font-weight:700">${escapeHtml(input.kind === "OVERDUE" ? "ACTION REQUIRED" : "REPAYMENT REMINDER")}</div><h1 style="font-size:25px;line-height:1.2;margin:18px 0 10px">${escapeHtml(titles[input.kind])}</h1><p style="font-size:15px;line-height:1.6;color:#526173">Hello ${escapeHtml(input.borrowerName)}, here is an update about your Velo loan repayment.</p><div style="margin:24px 0;padding:18px;background:#f7fafc;border:1px solid #e5edf5;border-radius:12px"><p style="margin:0 0 10px;color:#526173;font-size:13px">Outstanding balance</p><strong style="font-size:25px">₦${escapeHtml(input.outstandingNaira.toLocaleString("en-NG"))}</strong><p style="margin:14px 0 0;color:#526173;font-size:13px">Due date: <strong>${escapeHtml(input.dueDate)}</strong></p>${input.kind === "OVERDUE" ? `<p style="margin:8px 0 0;color:#b91c1c;font-size:13px">Late terms: ${escapeHtml(input.lateFee)}</p>` : ""}</div><p style="font-size:14px;line-height:1.6;color:#526173">Please sign in to your Velo dashboard to review your repayment schedule and use the available Flutterwave payment methods.</p><p style="font-size:13px;line-height:1.6;color:#718096">If you have already paid, please allow time for provider confirmation. Do not make a duplicate payment while your transaction is pending.</p></div><div style="padding:20px 30px;background:#17243d;color:#d7e7f5;font-size:12px;line-height:1.5">Velo Finance LTD · Nigeria<br/>This is an automated account notification. Please contact support if you need help.</div></div></body></html>` };
}

function brandedEmailHtml(content: string): string {
  const body = content.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? content;
  const logo = env.BRAND_LOGO_URL
    ? `<img src="${escapeHtml(env.BRAND_LOGO_URL)}" alt="Velo Finance" style="display:block;height:42px;width:auto;max-width:190px" />`
    : `<div style="font-size:24px;font-weight:800;letter-spacing:.08em;color:#17243d">VELO</div>`;
  return `<!doctype html><html><head><meta name="color-scheme" content="light" /><meta name="supported-color-schemes" content="light" /></head><body style="margin:0;background:#eef5fb;font-family:Arial,Helvetica,sans-serif;color:#17243d"><div style="padding:28px 12px"><div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #dce8f3;border-radius:22px;overflow:hidden;box-shadow:0 16px 42px rgba(15,35,65,.10)"><div style="padding:24px 30px;background:linear-gradient(135deg,#17243d,#14548b);border-bottom:4px solid #2196f3">${logo}</div><div style="padding:30px">${body}</div><div style="padding:22px 30px;background:#f5f9fd;border-top:1px solid #e3edf6;color:#60748a;font-size:12px;line-height:1.7">Velo Finance LTD · Nigeria<br/>This is an automated message from Velo Finance. Please do not share OTPs or account credentials.<br/><span style="color:#2196f3;font-weight:700">Finance that moves with you.</span></div></div></div></body></html>`;
}

export async function sendEmail(input: { to: string; name: string; subject: string; html: string }): Promise<{ sent: boolean; providerReference?: string }> {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) return { sent: false };
  const response = await fetch(`${env.BREVO_API_URL}/smtp/email`, { method: "POST", headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME }, to: [{ email: input.to, name: input.name }], subject: input.subject, htmlContent: brandedEmailHtml(input.html) }) });
  const data = await response.json() as { messageId?: string; message?: string };
  if (!response.ok) throw new Error(data.message || `Email provider failed (${response.status})`);
  return { sent: true, providerReference: data.messageId };
}
