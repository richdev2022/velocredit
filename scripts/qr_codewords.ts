// Prints codeword streams for diff against the Python reference.
import { debugCodewords } from "../frontend/src/utils/qrcode.js";

const payloads = [
  "https://velocredit.ng/face-verify?ht=abc123def456",
  "velo test 123 !!",
];
for (const payload of payloads) {
  for (const ec of ["L", "M"] as const) {
    const { version, codewords } = debugCodewords(payload, ec);
    console.log(`${payload.slice(0, 12)} ${ec} v${version}: ${codewords.map((c) => c.toString(16).padStart(2, "0")).join(" ")}`);
  }
}
