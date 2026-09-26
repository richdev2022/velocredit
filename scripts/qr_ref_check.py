#!/usr/bin/env python3
"""Compare frontend/src/utils/qrcode.ts output against the Python qrcode reference."""
import json
import subprocess
from pathlib import Path

import qrcode
from qrcode.util import QRData, MODE_8BIT_BYTE

ROOT = Path(__file__).resolve().parent.parent

# Run the TS encoder
subprocess.run(
    ["npx", "tsx", "scripts/qr_selftest.ts"],
    cwd=ROOT, check=True, capture_output=True,
)
mine = json.loads((ROOT / "scripts" / "qr_out.json").read_text())

EC = {"L": qrcode.constants.ERROR_CORRECT_L, "M": qrcode.constants.ERROR_CORRECT_M}

# Payloads mirrored from qr_selftest.ts, in the same order — qr_selftest emits
# entries grouped by payload, so we track a cursor instead of matching prefixes.
jwt_like = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + "b" * 140 + "." + "c" * 43
prefix = "https://velocredit.ng/face-verify?ht="

full_payloads = [
    "HELLO",
    "https://velocredit.ng/face-verify?ht=abc123def456",
    "https://velocredit.ng/face-verify?ht=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "Velo Finance LTD — face verification handoff link test payload with spaces and punctuation; 0123456789.",
    prefix + jwt_like,  # 258 chars → v12 M
    prefix + "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + "b" * 120 + "." + "c" * 43,  # 238 chars → v11 M
    prefix + jwt_like + "d" * 50,  # 308 chars → v13 M
    prefix + jwt_like + "e" * 91,  # 349 chars → v14 M / v13 L
    "z" + "f" * 429,  # 430 chars → v14 L (capacity 434)
]

# qr_selftest.ts iterates payloads → ec → mask, in that order, SKIPPING
# EC-M for payloads beyond the v14-M capacity (362 bytes). Mirror that here.
M_MAX = 362
ordered = []
for p in full_payloads:
    for ec in ("L", "M"):
        if ec == "M" and len(p.encode("utf-8")) > M_MAX:
            continue
        for mask in range(8):
            ordered.append((p, ec, mask))

passed = failed = version_mismatch = errors = 0
details = []
for index, entry in enumerate(mine):
    payload, expected_ec, expected_mask = ordered[index]
    if entry["ec"] != expected_ec or entry["mask"] != expected_mask:
        details.append(f"ORDER      index {index} unexpectedly {entry['ec']}/{entry['mask']}")
    if "error" in entry:
        errors += 1
        details.append(f"TS ERROR   {payload[:24]} ec={entry['ec']} mask={entry['mask']}: {entry['error']}")
        continue
    qr = qrcode.QRCode(error_correction=EC[entry["ec"]], mask_pattern=entry["mask"], border=0)
    # Force 8-BIT BYTE mode — our encoder is byte-mode-only (Python would
    # otherwise auto-select alphanumeric for uppercase-only payloads).
    qr.add_data(QRData(payload.encode("utf-8"), mode=MODE_8BIT_BYTE), optimize=0)
    qr.make(fit=True)
    ref = qr.get_matrix()
    ref_version = qr.version
    if ref_version != entry["version"]:
        version_mismatch += 1
        details.append(f"VERSION    idx {index} {payload[:24]} ec={entry['ec']} mask={entry['mask']}: ts={entry['version']} py={ref_version}")
        continue
    ref_rows = ["".join("1" if cell else "0" for cell in row) for row in ref]
    ok = ref_rows == entry["rows"]
    if ok:
        passed += 1
    else:
        failed += 1
        diffs = sum(1 for a, b in zip(ref_rows, entry["rows"]) for x, y in zip(a, b) if x != y)
        details.append(f"MISMATCH   idx {index} {payload[:24]} ec={entry['ec']} mask={entry['mask']}: {diffs} differing modules")

print(f"PASS {passed}  FAIL {failed}  VERSION_MISMATCH {version_mismatch}  TS_ERRORS {errors}")
for line in details[:20]:
    print(line)
