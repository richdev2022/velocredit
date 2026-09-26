/* Ambient module declarations for the in-house face-matching fallback stack.
   face-api.js 0.22.2 ships no TypeScript types; jpeg-js and pngjs ship none
   either. Only the surface actually used by backend/server/faceMatch.ts is
   declared — tensors always flow through faceapi.tf so that detection,
   landmarks and recognition share ONE @tensorflow/tfjs-core instance. */

declare module "face-api.js" {
  export interface VTensor {
    readonly shape: number[];
    dispose(): void;
  }
  export interface VTensor4D extends VTensor {
    /** rank-4 tensor [batch, height, width, channels] */
    readonly rank4: true;
  }

  export interface VPoint {
    x: number;
    y: number;
  }

  export interface VFaceDetection {
    box: { x: number; y: number; width: number; height: number };
    score: number;
  }

  export interface VFaceLandmarks {
    positions: VPoint[];
  }

  export interface VFaceResult {
    detection: VFaceDetection;
    landmarks: VFaceLandmarks;
    descriptor: Float32Array;
  }

  export class TinyFaceDetectorOptions {
    constructor(options?: { inputSize?: number; scoreThreshold?: number });
  }

  export const nets: {
    tinyFaceDetector: { loadFromDisk(path: string): Promise<void>; isLoaded: boolean };
    faceLandmark68Net: { loadFromDisk(path: string): Promise<void>; isLoaded: boolean };
    faceRecognitionNet: { loadFromDisk(path: string): Promise<void>; isLoaded: boolean };
  };

  export const tf: {
    setBackend(backendName: string): Promise<boolean>;
    ready(): Promise<void>;
    getBackend(): string;
    tensor3d(values: ArrayLike<number>, shape: [number, number, number], dtype?: "int32" | "float32"): VTensor;
    expandDims(tensor: VTensor, axis: number): VTensor4D;
  };

  export function detectAllFaces(
    input: VTensor4D,
    options?: TinyFaceDetectorOptions,
  ): {
    withFaceLandmarks(): {
      withFaceDescriptors(): Promise<VFaceResult[]>;
    };
  };
}

declare module "jpeg-js" {
  export interface JpegImageData {
    width: number;
    height: number;
    /** RGBA (default) or RGB depending on formatAsRGBA. */
    data: Uint8Array;
    comments?: string[];
  }
  export function decode(
    data: Uint8Array | ArrayBuffer,
    options?: { useTArray?: boolean; tolerantDecoding?: boolean; formatAsRGBA?: boolean },
  ): JpegImageData;
  export function encode(imageData: { width: number; height: number; data: Uint8Array }, quality?: number): { data: Uint8Array };
}

declare module "pngjs" {
  export class PNG {
    width: number;
    height: number;
    /** RGBA pixel data */
    data: Uint8Array;
    static sync: {
      read(buffer: Uint8Array): PNG;
    };
  }
}
