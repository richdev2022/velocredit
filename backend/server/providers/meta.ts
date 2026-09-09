import { env } from "../config.js";

export interface WhatsAppTemplateComponent {
  type: "header" | "body" | "button";
  parameters?: Array<{ type: "text" | "currency" | "date_time" | "image" | "document"; text?: string; currency?: { fallback_value: string; code: string; amount_1000: number }; date_time?: { fallback_value: string }; image?: { link: string }; document?: { link: string } }>;
}

export interface WhatsAppTemplateMessage {
  to: string;
  templateName: string;
  languageCode?: string;
  components?: WhatsAppTemplateComponent[];
}

export interface WhatsAppTextMessage {
  to: string;
  text: string;
  previewUrl?: boolean;
}

export interface WhatsAppSendResult {
  sent: boolean;
  providerMessageId?: string;
  status: "queued" | "sent" | "delivered" | "read" | "FAILED";
  error?: string;
  providerConfigured: boolean;
}

async function metaRequest<T>(path: string, body: Record<string, unknown>, method: "POST" | "GET" = "POST"): Promise<T> {
  if (!env.META_WHATSAPP_ACCESS_TOKEN || !env.META_WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("Meta WhatsApp Cloud API is not configured");
  }
  const url = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${env.META_WHATSAPP_PHONE_NUMBER_ID}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.META_WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const data = await response.json() as T & { error?: { message?: string; code?: number } };
  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Meta request failed (${response.status})`);
  }
  return data;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("234")) return digits;
  if (digits.startsWith("0")) return `234${digits.slice(1)}`;
  if (digits.length === 10) return `234${digits}`;
  return digits;
}

export async function sendWhatsAppText(input: WhatsAppTextMessage): Promise<WhatsAppSendResult> {
  try {
    const to = normalizePhone(input.to);
    const response = await metaRequest<{ messages?: Array<{ id: string }> }>("/messages", {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      text: { preview_url: input.previewUrl ?? false, body: input.text },
    });
    const messageId = response.messages?.[0]?.id;
    return {
      sent: Boolean(messageId),
      providerMessageId: messageId,
      status: messageId ? "queued" : "FAILED",
      providerConfigured: true,
    };
  } catch (error) {
    if (!env.META_WHATSAPP_ACCESS_TOKEN || !env.META_WHATSAPP_PHONE_NUMBER_ID) {
      return { sent: false, status: "FAILED", error: "Meta WhatsApp not configured", providerConfigured: false };
    }
    return {
      sent: false,
      status: "FAILED",
      error: error instanceof Error ? error.message : "Meta send failed",
      providerConfigured: true,
    };
  }
}

export async function sendWhatsAppTemplate(input: WhatsAppTemplateMessage): Promise<WhatsAppSendResult> {
  try {
    const to = normalizePhone(input.to);
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.languageCode || "en_US", policy: "deterministic" },
        components: input.components || [],
      },
    };
    const response = await metaRequest<{ messages?: Array<{ id: string }> }>("/messages", payload);
    const messageId = response.messages?.[0]?.id;
    return {
      sent: Boolean(messageId),
      providerMessageId: messageId,
      status: messageId ? "queued" : "FAILED",
      providerConfigured: true,
    };
  } catch (error) {
    if (!env.META_WHATSAPP_ACCESS_TOKEN || !env.META_WHATSAPP_PHONE_NUMBER_ID) {
      return { sent: false, status: "FAILED", error: "Meta WhatsApp not configured", providerConfigured: false };
    }
    return {
      sent: false,
      status: "FAILED",
      error: error instanceof Error ? error.message : "Meta template send failed",
      providerConfigured: true,
    };
  }
}

export function buildOtpTemplate(otp: string, actionLabel: string, ttlMinutes: number): WhatsAppTemplateMessage["components"] {
  return [
    {
      type: "body",
      parameters: [
        { type: "text", text: otp },
        { type: "text", text: actionLabel },
        { type: "text", text: `${ttlMinutes} minutes` },
      ],
    },
  ];
}

export function maskPhoneForWa(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
}
