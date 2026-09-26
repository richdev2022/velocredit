import { fileURLToPath } from "node:url";
import * as faceapi from "face-api.js";
import { decode as decodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";
import { env } from "./config.js";

/* =========================================================================
   In-house (custom) face comparison — the LOCAL FALLBACK for Prembly.

   Why: Prembly's face comparison intermittently rejects genuine customers
   (false mismatches) — most often with the low-resolution NIBSS/NIMC
   government portraits. When the Prembly ladder does not produce a match,
   this module runs a fully local face-embedding comparison so a genuine
   customer is never blocked by a single provider opinion.

   How: face-api.js (pure-JS TensorFlow CPU backend, models vendored in
   ./faceapi-models — no native binaries, works on any Node host):
     1. decode the image (JPEG or PNG) into an RGB tensor,
     2. tiny-face-detector finds the face (largest box wins),
     3. 68-point landmarks align the face,
     4. the FaceRecognition net produces a 128-d descriptor,
     5. the Euclidean distance between the two descriptors decides:
        distance <= CUSTOM_FACE_MATCH_MAX_DISTANCE  ⇒  same person.
   Every failure mode degrades to { available: false } so the KYC route can
   carry on — this fallback must never break the verification flow.
   ========================================================================= */

export interface CustomFaceMatchResult {
  /** false ⇒ the engine could not run at all (init/decode failure) — caller should ignore this result. */
  available: boolean;
  matched: boolean;
  /** Euclidean distance between the 128-d descriptors (0 = identical). */
  distance?: number;
  /** Human-facing 0-100 score mapped from the distance. */
  confidence?: number;
  facesDetected?: { selfie: number; portrait: number };
  detail?: string;
}

/** Face-api standard same-person threshold is 0.6 — we start stricter. */
const DEFAULT_MAX_DISTANCE = 0.55;
const DETECTOR_INPUT_SIZE = 320;
const DETECTOR_SCORE = 0.3;

let enginePromise: Promise<boolean> | null = null;

/** Loads the models once; resolves false when the engine is unusable. */
function ensureEngine(): Promise<boolean> {
  if (!enginePromise) {
    enginePromise = (async () => {
      await faceapi.tf.setBackend("cpu");
      await faceapi.tf.ready();
      const modelsDir = fileURLToPath(new URL("./faceapi-models/", import.meta.url));
      await faceapi.nets.tinyFaceDetector.loadFromDisk(modelsDir);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsDir);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsDir);
      return true;
    })()
      .catch((error: unknown) => {
        console.error("[faceMatch] engine init failed:", error instanceof Error ? error.message : error);
        return false;
      });
  }
  return enginePromise;
}

/** Decodes JPEG/PNG bytes into an RGB float tensor batched to 4D. */
function bufferToTensor(buffer: Buffer): faceapi.VTensor4D | undefined {
  const trimmed = buffer.subarray(0, Math.min(buffer.length, 8));
  const isPng = trimmed[0] === 0x89 && trimmed[1] === 0x50;
  const isJpeg = trimmed[0] === 0xff && trimmed[1] === 0xd8;
  let width = 0;
  let height = 0;
  let rgba: Uint8Array | undefined;

  if (isJpeg) {
    const image = decodeJpeg(new Uint8Array(buffer), { useTArray: true, tolerantDecoding: true });
    width = image.width;
    height = image.height;
    rgba = image.data;
  } else if (isPng) {
    const image = PNG.sync.read(new Uint8Array(buffer));
    width = image.width;
    height = image.height;
    rgba = image.data;
  } else {
    return undefined;
  }
  if (!width || !height || !rgba || rgba.length < width * height * 3) return undefined;

  let rgb: Uint8Array;
  if (rgba.length === width * height * 4) {
    rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
  } else {
    rgb = rgba;
  }

  return faceapi.tf.tensor3d(rgb, [height, width, 3], "int32") as unknown as faceapi.VTensor4D;
}

interface DescriptorHit {
  descriptor: Float32Array;
  faces: number;
}

/** Detects the dominant (largest) face and returns its aligned 128-d descriptor. */
async function bestDescriptor(buffer: Buffer): Promise<DescriptorHit | undefined> {
  const tensor = bufferToTensor(buffer);
  if (!tensor) return undefined;
  try {
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: DETECTOR_INPUT_SIZE, scoreThreshold: DETECTOR_SCORE });
    let results = await faceapi.detectAllFaces(tensor, options).withFaceLandmarks().withFaceDescriptors();
    if (results.length === 0) {
      // One relaxed retry — small/soft government portraits occasionally score low.
      const relaxed = new faceapi.TinyFaceDetectorOptions({ inputSize: DETECTOR_INPUT_SIZE, scoreThreshold: 0.2 });
      results = await faceapi.detectAllFaces(tensor, relaxed).withFaceLandmarks().withFaceDescriptors();
    }
    if (results.length === 0) return undefined;
    let best = results[0];
    for (const hit of results) {
      if (hit.detection.box.width * hit.detection.box.height > best.detection.box.width * best.detection.box.height) best = hit;
    }
    return { descriptor: best.descriptor, faces: results.length };
  } finally {
    tensor.dispose();
  }
}

function descriptorDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/** Public entry: compares two image buffers locally. Never throws. */
export async function customFaceMatch(selfie: Buffer, portrait: Buffer): Promise<CustomFaceMatchResult> {
  const ready = await ensureEngine();
  if (!ready) {
    return { available: false, matched: false, detail: "Local face matcher could not initialise" };
  }
  try {
    const [selfieHit, portraitHit] = await Promise.all([bestDescriptor(selfie), bestDescriptor(portrait)]);
    if (!selfieHit || !portraitHit) {
      return {
        available: true,
        matched: false,
        facesDetected: { selfie: selfieHit?.faces ?? 0, portrait: portraitHit?.faces ?? 0 },
        detail: !selfieHit ? "No face detected in the selfie" : "No face detected in the identity portrait",
      };
    }
    const distance = descriptorDistance(selfieHit.descriptor, portraitHit.descriptor);
    const maxDistance = typeof env.CUSTOM_FACE_MATCH_MAX_DISTANCE === "number" && env.CUSTOM_FACE_MATCH_MAX_DISTANCE > 0
      ? env.CUSTOM_FACE_MATCH_MAX_DISTANCE
      : DEFAULT_MAX_DISTANCE;
    const matched = distance <= maxDistance;
    // Map distance → 0-100: d=0 ⇒ 100, d≈1.1+ ⇒ 0. Threshold 0.55 ≈ 50%.
    const confidence = Math.max(0, Math.min(100, Math.round((1 - distance / 1.1) * 100)));
    return {
      available: true,
      matched,
      distance: Math.round(distance * 1000) / 1000,
      confidence,
      facesDetected: { selfie: selfieHit.faces, portrait: portraitHit.faces },
      detail: matched ? "Local face embedding match" : "Local face embedding did not match",
    };
  } catch (error) {
    console.error("[faceMatch] comparison failed:", error instanceof Error ? error.message : error);
    return { available: false, matched: false, detail: "Local face matcher failed unexpectedly" };
  }
}

/** Tests only: exposes whether the models are loaded without running a match. */
export async function isCustomMatcherReady(): Promise<boolean> {
  return ensureEngine();
}
