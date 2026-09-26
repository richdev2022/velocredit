// Cross-verification self-test: my hand-rolled QR encoder vs the Python
// `qrcode` reference library. For each test payload and forced mask 0-7 both
// matrices are compared cell-by-cell (version is printed too — a mismatch in
// version selection is reported separately from module mismatches).
import { writeFileSync } from "node:fs";
import { encodeQr } from "../frontend/src/utils/qrcode.js";

const payloads = [
  "HELLO",
  "https://velocredit.ng/face-verify?ht=abc123def456",
  "https://velocredit.ng/face-verify?ht=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "Velo Finance LTD — face verification handoff link test payload with spaces and punctuation; 0123456789.",
];

const results: Array<Record<string, unknown>> = [];
for (const payload of payloads) {
  for (const ec of ["L", "M"] as const) {
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
