import "dotenv/config";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* =========================================================================
   Face comparison robustness tests:
     1. Prembly compareFaces response parsing (incl. the response_code "00"
        false-positive quirk fixed in this change).
     2. The CUSTOM in-house fallback matcher (faceMatch.ts) against real
       face fixtures — same person must match, different people must not.
   ========================================================================= */

const here = dirname(fileURLToPath(import.meta.url));

type PremblyModule = typeof import("./providers/prembly.js");

let prembly: PremblyModule;

beforeAll(async () => {
  const config = await import("./config.js");
  // premblyPost refuses to call the API without a key — the parsing tests stub
  // fetch itself, so any placeholder key is enough here.
  (config.env as { PREMBLY_API_KEY?: string }).PREMBLY_API_KEY = "test-key-for-unit-tests";
  prembly = await import("./providers/prembly.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("compareFaces — Prembly response parsing", () => {
  const stubPrembly = (payload: unknown, reject = false) => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (reject) throw new Error("The operation was aborted due to timeout");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
      };
    }) as unknown as typeof fetch);
  };

  it("treats the documented match envelope as a match", async () => {
    stubPrembly({ status: true, response_code: "00", message: "Fatch Match", confidence: 100 });
    const result = await prembly.compareFaces({ imageOne: "a", imageTwo: "b" });
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe(100);
    expect(result.unavailable).toBe(false);
  });

  it("does NOT treat an explicit status:false + response_code 00 as a match (false-positive quirk)", async () => {
    stubPrembly({ status: false, response_code: "00", message: "Face did not match", confidence: 34 });
    const result = await prembly.compareFaces({ imageOne: "a", imageTwo: "b" });
    expect(result.matched).toBe(false);
    expect(result.unavailable).toBe(false);
  });

  it("accepts a string 'true' status", async () => {
    stubPrembly({ status: "true", response_code: "00", confidence: "88" });
    const result = await prembly.compareFaces({ imageOne: "a", imageTwo: "b" });
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe(88);
  });

  it("marks transport failures as unavailable (verdict unknown, not 'no match')", async () => {
    stubPrembly(null, true);
    const result = await prembly.compareFaces({ imageOne: "a", imageTwo: "b" });
    expect(result.matched).toBe(false);
    expect(result.unavailable).toBe(true);
    expect(result.errorMessage).toMatch(/aborted|timeout|not configured/i);
  });

  it("keeps working when the provider answers with a non-2xx envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ message: "Internal Server Error" }),
    })) as unknown as typeof fetch);
    const result = await prembly.compareFaces({ imageOne: "a", imageTwo: "b" });
    expect(result.matched).toBe(false);
    expect(result.unavailable).toBe(true);
  });
});

describe("customFaceMatch — in-house face-embedding fallback", () => {
  const portraitA = () => readFileSync(join(here, "test-fixtures", "face-portrait-a.jpg"));
  const portraitB = () => readFileSync(join(here, "test-fixtures", "face-portrait-b.jpg"));

  it("matches the SAME person (identical image)", { timeout: 120_000 }, async () => {
    const { customFaceMatch } = await import("./faceMatch.js");
    const result = await customFaceMatch(portraitA(), portraitA());
    expect(result.available).toBe(true);
    expect(result.matched).toBe(true);
    expect(result.distance).toBeLessThanOrEqual(0.55);
  });

  it("matches the SAME person across a mirrored, recompressed capture", { timeout: 120_000 }, async () => {
    const jpeg = await import("jpeg-js");
    const decoded = jpeg.decode(new Uint8Array(portraitA()), { useTArray: true });
    // Horizontal mirror — simulates a different camera angle/capture of the same face.
    const { width, height, data } = decoded;
    const flipped = new Uint8Array(data.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const src = (y * width + x) * 4;
        const dst = (y * width + (width - 1 - x)) * 4;
        flipped[dst] = data[src];
        flipped[dst + 1] = data[src + 1];
        flipped[dst + 2] = data[src + 2];
        flipped[dst + 3] = data[src + 3];
      }
    }
    const encoded = jpeg.encode({ width, height, data: flipped }, 82);
    const { customFaceMatch } = await import("./faceMatch.js");
    const result = await customFaceMatch(portraitA(), Buffer.from(encoded.data));
    expect(result.available).toBe(true);
    expect(result.matched).toBe(true);
  }, 120_000);

  it("does NOT match two DIFFERENT people", { timeout: 120_000 }, async () => {
    const { customFaceMatch } = await import("./faceMatch.js");
    const result = await customFaceMatch(portraitA(), portraitB());
    expect(result.available).toBe(true);
    expect(result.matched).toBe(false);
    expect(result.distance).toBeGreaterThan(0.55);
  });

  it("degrades gracefully on undecodable input", { timeout: 120_000 }, async () => {
    const { customFaceMatch } = await import("./faceMatch.js");
    const result = await customFaceMatch(Buffer.from("not-an-image-at-all-really-not"), portraitA());
    expect(result.matched).toBe(false);
  });
});
