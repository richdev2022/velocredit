// Cross-verification self-test: my hand-rolled QR encoder vs the Python
// `qrcode` reference library. For each test payload and forced mask 0-7 both
// matrices are compared cell-by-cell (version is printed too — a mismatch in
// version selection is reported separately from module mismatches).
//
// Payload lengths are chosen to force every supported version band:
//   byte capacity at EC M — v10: 213, v11: 251, v12: 287, v13: 331, v14: 362
//   byte capacity at EC L — v10: 271, v11: 321, v12: 367, v13: 425, v14: 520
import { writeFileSync } from "node:fs";
import { encodeQr } from "../frontend/src/utils/qrcode.js";

/** Byte-mode capacity ceiling of version 14 at EC M — payloads beyond this are L-only. */
const M_MAX = 362;

const jwtLike = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${"b".repeat(140)}.${"c".repeat(43)}`; // 221 chars, like a real handoff JWT
const prefix = "https://velocredit.ng/face-verify?ht=";

const payloads = [
  "HELLO",
  "https://velocredit.ng/face-verify?ht=abc123def456",
  "https://velocredit.ng/face-verify?ht=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "Velo Finance LTD — face verification handoff link test payload with spaces and punctuation; 0123456789.",
  `${prefix}${jwtLike}`, // 258 chars → v12 M
  `${prefix}${"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."}${"b".repeat(120)}.${"c".repeat(43)}`, // 238 chars → v11 M
  `${prefix}${jwtLike}${"d".repeat(50)}`, // 308 chars → v13 M
  `${prefix}${jwtLike}${"e".repeat(91)}`, // 349 chars → v14 M / v13 L
  `z${"f".repeat(429)}`, // 430 chars → v14 L (M skipped — beyond v14 M)
];

const results: Array<Record<string, unknown>> = [];
for (const payload of payloads) {
  for (const ec of ["L", "M"] as const) {
    if (ec === "M" && new TextEncoder().encode(payload).length > M_MAX) continue; // mirror of the Python checker's ordered list
    for (let mask = 0; mask < 8; mask++) {
      try {
        const qr = encodeQr(payload, ec, mask);
        results.push({
          payload: payload.slice(0, 24),
          ec,
          mask,
          version: (qr.size - 17) / 4,
          size: qr.size,
          rows: qr.modules.map((row) => row.map((cell) => (cell ? "1" : "0")).join("")),
        });
      } catch (error) {
        results.push({ payload: payload.slice(0, 24), ec, mask, error: String(error) });
      }
    }
  }
}
writeFileSync(new URL("./qr_out.json", import.meta.url), JSON.stringify(results, null, 1));
console.log(`wrote ${results.length} matrices`);
