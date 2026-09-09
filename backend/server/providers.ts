import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./config.js";
import { verifyPremblyWebhook as verifyPremblyWebhookInner } from "./providers/prembly.js";
import { verifyKudiSignature as verifyKudiSignatureInner } from "./providers/kudi.js";

export function verifyFlutterwaveWebhook(signature: string | undefined, rawBody?: string): boolean {
  if (!env.FLUTTERWAVE_WEBHOOK_SECRET || !signature) return false;
  const expectedLegacy = Buffer.from(env.FLUTTERWAVE_WEBHOOK_SECRET);
  const received = Buffer.from(signature);
  if (expectedLegacy.length === received.length && timingSafeEqual(expectedLegacy, received)) return true;
  if (rawBody) {
    const hmac = createHmac("sha256", env.FLUTTERWAVE_WEBHOOK_SECRET).update(rawBody).digest("hex");
    const expectedHmac = Buffer.from(hmac);
    if (expectedHmac.length === received.length && timingSafeEqual(expectedHmac, received)) return true;
    const hmacWithPrefix = Buffer.from(`sha256=${hmac}`);
    if (hmacWithPrefix.length === received.length && timingSafeEqual(hmacWithPrefix, received)) return true;
  }
  return false;
}

export function verifyMetaWebhookSignature(signature: string | undefined, rawBody: string): boolean {
  if (!env.META_WHATSAPP_APP_SECRET || !signature) return false;
  const expected = createHmac("sha256", env.META_WHATSAPP_APP_SECRET).update(rawBody).digest("hex");
  const expectedWithPrefix = `sha256=${expected}`;
  const expectedBuf = Buffer.from(expectedWithPrefix);
  const receivedBuf = Buffer.from(signature);
  return expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf);
}

export function verifyPremblyWebhook(signature: string | undefined, rawBody: string): boolean {
  return verifyPremblyWebhookInner(signature, rawBody);
}

export function verifyKudiSignature(signature: string | undefined, rawBody: string): boolean {
  return verifyKudiSignatureInner(signature, rawBody);
}

export function providerStatus(provider: "flutterwave" | "prembly" | "kudi" | "meta") {
  const configured = provider === "flutterwave" ? Boolean(env.FLUTTERWAVE_SECRET_KEY) : provider === "prembly" ? Boolean(env.PREMBLY_API_KEY) : provider === "kudi" ? Boolean(env.KUDI_API_KEY) : Boolean(env.META_WHATSAPP_ACCESS_TOKEN && env.META_WHATSAPP_PHONE_NUMBER_ID);
  return { provider, configured };
}
