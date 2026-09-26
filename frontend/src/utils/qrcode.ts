// ============================================================================
// src/utils/qrcode.ts
// Dependency-free QR Code encoder (byte mode, versions 1-14, EC levels L/M).
//
// v11-14 exist because the face hand-off link (frontend origin + JWT) is
// ~260 bytes — beyond the 213-byte ceiling of version 10 at EC M, which
// silently blanked the QR canvas before.
//
// Why hand-rolled: the selfie hand-off link must be rendered as a QR code the
// customer scans with their phone camera, and adding a QR npm dependency is
// not an option in this environment. This module implements the classic
// QR "model 2" algorithm faithfully (Galois-field Reed–Solomon error
// correction, finder/alignment/timing/format patterns, best-mask selection)
// so any standard camera app can scan the result.
// ============================================================================

/* ----------------------------- Galois field ------------------------------ */

const EXP_TABLE = new Uint8Array(256);
const LOG_TABLE = new Uint8Array(256);
(function initGaloisTables() {
  for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
  for (let i = 8; i < 256; i++) EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
  for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;
})();

function glog(n: number): number {
  if (n < 1) throw new Error(`qrcode: glog(${n})`);
  return LOG_TABLE[n];
}

function gexp(n: number): number {
  while (n < 0) n += 255;
  while (n >= 255) n -= 255;
  return EXP_TABLE[n];
}

/* ---------------------------- RS polynomials ----------------------------- */

/** Polynomial = coefficient array, highest degree first. */
function polyMultiply(a: number[], b: number[]): number[] {
  const num = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      num[i + j] ^= gexp(glog(a[i]) + glog(b[j]));
    }
  }
  return num;
}

function polyMod(a: number[], b: number[]): number[] {
  // Normalize: strip leading zeros (mirrors QRPolynomial construction in the
  // reference algorithm — degree reduction after each XOR step).
  let start = 0;
  while (start < a.length && a[start] === 0) start++;
  const clean = a.slice(start);
  if (clean.length - b.length < 0) return clean;
  const ratio = glog(clean[0]) - glog(b[0]);
  const num = clean.slice();
  for (let i = 0; i < b.length; i++) num[i] ^= gexp(glog(b[i]) + ratio);
  return polyMod(num, b);
}

function errorCorrectPolynomial(errorCorrectLength: number): number[] {
  let poly = [1];
  for (let i = 0; i < errorCorrectLength; i++) poly = polyMultiply(poly, [1, gexp(i)]);
  return poly;
}

/* ------------------------------ RS blocks -------------------------------- */

// Flat table: index = (version - 1) * 2 + (ecLevel === "L" ? 0 : 1).
// Each entry: triples/quadruples of [blockCount, totalCount, dataCount, ...].
const RS_BLOCK_TABLE: number[][] = [
  /* v1  L */ [1, 26, 19], /* v1  M */ [1, 26, 16],
  /* v2  L */ [1, 44, 34], /* v2  M */ [1, 44, 28],
  /* v3  L */ [1, 70, 55], /* v3  M */ [1, 70, 44],
  /* v4  L */ [1, 100, 80], /* v4  M */ [2, 50, 32],
  /* v5  L */ [1, 134, 108], /* v5  M */ [2, 67, 43],
  /* v6  L */ [2, 86, 68], /* v6  M */ [4, 43, 27],
  /* v7  L */ [2, 98, 78], /* v7  M */ [4, 49, 31],
  /* v8  L */ [2, 121, 97], /* v8  M */ [2, 60, 38, 2, 61, 39],
  /* v9  L */ [2, 146, 116], /* v9  M */ [3, 58, 36, 2, 59, 37],
  /* v10 L */ [2, 86, 68, 2, 87, 69], /* v10 M */ [4, 69, 43, 1, 70, 44],
  /* v11 L */ [4, 101, 81], /* v11 M */ [1, 80, 50, 4, 81, 51],
  /* v12 L */ [2, 116, 92, 2, 117, 93], /* v12 M */ [6, 58, 36, 2, 59, 37],
  /* v13 L */ [4, 133, 107], /* v13 M */ [8, 59, 37, 1, 60, 38],
  /* v14 L */ [3, 145, 115, 1, 146, 116], /* v14 M */ [4, 64, 40, 5, 65, 41],
];

interface RsBlock { totalCount: number; dataCount: number; }

function rsBlocksFor(version: number, ecLevel: "L" | "M"): RsBlock[] {
  const entry = RS_BLOCK_TABLE[(version - 1) * 2 + (ecLevel === "L" ? 0 : 1)];
  const blocks: RsBlock[] = [];
  for (let i = 0; i < entry.length; i += 3) {
    const count = entry[i];
    const totalCount = entry[i + 1];
    const dataCount = entry[i + 2];
    for (let b = 0; b < count; b++) blocks.push({ totalCount, dataCount });
  }
  return blocks;
}

/* ------------------------------ Bit buffer ------------------------------- */

class BitBuffer {
  buffer: number[] = [];
  length = 0;

  put(num: number, length: number): void {
    for (let i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) === 1);
  }

  putBit(bit: boolean): void {
    const bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) this.buffer.push(0);
    if (bit) this.buffer[bufIndex] |= 0x80 >>> (this.length % 8);
    this.length += 1;
  }
}

/* ------------------------------ BCH codes -------------------------------- */

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

function bchDigit(data: number): number {
  let digit = 0;
  while (data !== 0) { digit += 1; data >>>= 1; }
  return digit;
}

function bchTypeInfo(data: number): number {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

function bchTypeNumber(data: number): number {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

/* --------------------------- Mask functions ------------------------------ */

function maskFunction(pattern: number): (i: number, j: number) => boolean {
  switch (pattern) {
    case 0: return (i, j) => (i + j) % 2 === 0;
    case 1: return (i) => i % 2 === 0;
    case 2: return (_i, j) => j % 3 === 0;
    case 3: return (i, j) => (i + j) % 3 === 0;
    case 4: return (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default: throw new Error(`qrcode: bad mask pattern ${pattern}`);
  }
}

const PATTERN_POSITION_TABLE: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
];

/* ------------------------------ Core build ------------------------------- */

function createDataBytes(bytes: Uint8Array, version: number, ecLevel: "L" | "M"): number[] {
  const blocks = rsBlocksFor(version, ecLevel);
  const totalDataCount = blocks.reduce((sum, block) => sum + block.dataCount, 0);
  const buffer = new BitBuffer();
  buffer.put(0x4, 4); // byte mode
  buffer.put(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) buffer.put(byte, 8);
  if (buffer.length > totalDataCount * 8) throw new Error("qrcode: payload too long");
  if (buffer.length + 4 <= totalDataCount * 8) buffer.put(0, 4);
  while (buffer.length % 8 !== 0) buffer.putBit(false);
  while (true) {
    if (buffer.length >= totalDataCount * 8) break;
    buffer.put(0xec, 8);
    if (buffer.length >= totalDataCount * 8) break;
    buffer.put(0x11, 8);
  }

  // Reed–Solomon: split into blocks, compute EC per block, interleave.
  let offset = 0;
  let maxDcCount = 0;
  let maxEcCount = 0;
  const dcdata: number[][] = [];
  const ecdata: number[][] = [];
  for (const block of blocks) {
    const dcCount = block.dataCount;
    const ecCount = block.totalCount - dcCount;
    maxDcCount = Math.max(maxDcCount, dcCount);
    maxEcCount = Math.max(maxEcCount, ecCount);
    const dc = buffer.buffer.slice(offset, offset + dcCount);
    offset += dcCount;
    dcdata.push(dc);
    const rsPoly = errorCorrectPolynomial(ecCount);
    const modPoly = polyMod([...dc, ...new Array<number>(rsPoly.length - 1).fill(0)], rsPoly);
    const ec = new Array<number>(rsPoly.length - 1).fill(0);
    for (let i = 0; i < ec.length; i++) {
      // Remainder is aligned to the RIGHT end of the EC buffer (reference:
      // modIndex = i + modPoly.length - ecLength).
      const modIndex = i + modPoly.length - ec.length;
      ec[i] = modIndex >= 0 ? modPoly[modIndex] : 0;
    }
    ecdata.push(ec);
  }
  const data: number[] = [];
  for (let i = 0; i < maxDcCount; i++) for (const dc of dcdata) if (i < dc.length) data.push(dc[i]);
  for (let i = 0; i < maxEcCount; i++) for (const ec of ecdata) if (i < ec.length) data.push(ec[i]);
  return data;
}

export interface QrMatrix { size: number; modules: boolean[][]; }

/** Test hook: final codeword stream (data + Reed–Solomon EC, interleaved). */
export function debugCodewords(text: string, ecLevel: "L" | "M" = "M"): { version: number; codewords: number[] } {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let candidate = 1; candidate <= 14; candidate++) {
    const blocks = rsBlocksFor(candidate, ecLevel);
    const dataCount = blocks.reduce((sum, block) => sum + block.dataCount, 0);
    if (4 + (candidate <= 9 ? 8 : 16) + bytes.length * 8 <= dataCount * 8) { version = candidate; break; }
  }
  if (!version) throw new Error("qrcode: payload too long");
  return { version, codewords: createDataBytes(bytes, version, ecLevel) };
}

/**
 * Encodes `text` (UTF-8, byte mode) into a QR matrix, automatically picking
 * the smallest version 1-14 that fits at the requested error-correction
 * level and the mask pattern with the lowest penalty score.
 * `maskOverride` forces a specific mask 0-7 (used by the cross-verification
 * self-test against the reference implementation).
 */
export function encodeQr(text: string, ecLevel: "L" | "M" = "M", maskOverride?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let candidate = 1; candidate <= 14; candidate++) {
    const blocks = rsBlocksFor(candidate, ecLevel);
    const dataCount = blocks.reduce((sum, block) => sum + block.dataCount, 0);
    if (4 + (candidate <= 9 ? 8 : 16) + bytes.length * 8 <= dataCount * 8) { version = candidate; break; }
  }
  if (!version) throw new Error("qrcode: payload too long for supported versions");

  const moduleCount = version * 4 + 17;
  const data = createDataBytes(bytes, version, ecLevel);

  let best: { modules: boolean[][]; lost: number } | null = null;
  for (let maskPattern = 0; maskPattern < 8; maskPattern++) {
    if (maskOverride !== undefined && maskPattern !== maskOverride) continue;
    const modules: boolean[][] = Array.from({ length: moduleCount }, () => new Array<boolean>(moduleCount).fill(false));
    const grid: (boolean | null)[][] = Array.from({ length: moduleCount }, () => new Array<boolean | null>(moduleCount).fill(null));
    const set = (row: number, col: number, value: boolean) => { if (row >= 0 && row < moduleCount && col >= 0 && col < moduleCount) grid[row][col] = value; };

    const setupPositionProbePattern = (row: number, col: number) => {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          if (row + r <= -1 || moduleCount <= row + r || col + c <= -1 || moduleCount <= col + c) continue;
          const dark = (0 <= r && r <= 6 && (c === 0 || c === 6)) || (0 <= c && c <= 6 && (r === 0 || r === 6)) || (2 <= r && r <= 4 && 2 <= c && c <= 4);
          set(row + r, col + c, dark);
        }
      }
    };
    setupPositionProbePattern(0, 0);
    setupPositionProbePattern(moduleCount - 7, 0);
    setupPositionProbePattern(0, moduleCount - 7);

    const positions = PATTERN_POSITION_TABLE[version - 1];
    for (const row of positions) {
      for (const col of positions) {
        if (grid[row][col] != null) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            set(row + r, col + c, r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0));
          }
        }
      }
    }

    for (let r = 8; r < moduleCount - 8; r++) if (grid[r][6] == null) set(r, 6, r % 2 === 0);
    for (let c = 8; c < moduleCount - 8; c++) if (grid[6][c] == null) set(6, c, c % 2 === 0);

    // Format info (errorCorrectLevel format value: L=1, M=0)
    const formatValue = (ecLevel === "L" ? 1 : 0) << 3 | maskPattern;
    const formatBits = bchTypeInfo(formatValue);
    for (let i = 0; i < 15; i++) {
      const dark = ((formatBits >> i) & 1) === 1;
      if (i < 6) set(i, 8, dark);
      else if (i < 8) set(i + 1, 8, dark);
      else set(moduleCount - 15 + i, 8, dark);
    }
    for (let i = 0; i < 15; i++) {
      const dark = ((formatBits >> i) & 1) === 1;
      if (i < 8) set(8, moduleCount - i - 1, dark);
      else if (i < 9) set(8, 15 - i - 1 + 1, dark);
      else set(8, 15 - i - 1, dark);
    }
    set(moduleCount - 8, 8, true); // dark module

    // Version info (required for version >= 7)
    if (version >= 7) {
      const typeBits = bchTypeNumber(version);
      for (let i = 0; i < 18; i++) {
        const dark = ((typeBits >> i) & 1) === 1;
        set(Math.floor(i / 3), (i % 3) + moduleCount - 8 - 3, dark);
        set((i % 3) + moduleCount - 8 - 3, Math.floor(i / 3), dark);
      }
    }

    // Data placement (two-column serpentines, bottom-right to top-left)
    const isMasked = maskFunction(maskPattern);
    let inc = -1;
    let row = moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    for (let col = moduleCount - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      while (true) {
        for (let c = 0; c < 2; c++) {
          if (grid[row][col - c] == null) {
            let dark = false;
            if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
            if (isMasked(row, col - c)) dark = !dark;
            set(row, col - c, dark);
            bitIndex -= 1;
            if (bitIndex === -1) { byteIndex += 1; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || moduleCount <= row) { row -= inc; inc = -inc; break; }
      }
    }

    // Penalty score (ISO/IEC 18004 rules 1-4)
    let lostPoint = 0;
    for (let r = 0; r < moduleCount; r++) {
      for (let c = 0; c < moduleCount; c++) {
        let sameCount = 0;
        const dark = grid[r][c]!;
        for (let dr = -1; dr <= 1; dr++) {
          if (r + dr < 0 || moduleCount <= r + dr) continue;
          for (let dc = -1; dc <= 1; dc++) {
            if (c + dc < 0 || moduleCount <= c + dc) continue;
            if (dr === 0 && dc === 0) continue;
            if (dark === grid[r + dr][c + dc]) sameCount += 1;
          }
        }
        if (sameCount > 5) lostPoint += 3 + sameCount - 5;
      }
    }
    for (let r = 0; r < moduleCount - 1; r++) {
      for (let c = 0; c < moduleCount - 1; c++) {
        const count = (grid[r][c] ? 1 : 0) + (grid[r + 1][c] ? 1 : 0) + (grid[r][c + 1] ? 1 : 0) + (grid[r + 1][c + 1] ? 1 : 0);
        if (count === 0 || count === 4) lostPoint += 3;
      }
    }
    for (let r = 0; r < moduleCount; r++) {
      for (let c = 0; c < moduleCount - 6; c++) {
        if (grid[r][c] && !grid[r][c + 1] && grid[r][c + 2] && grid[r][c + 3] && grid[r][c + 4] && !grid[r][c + 5] && grid[r][c + 6]) lostPoint += 40;
      }
    }
    for (let c = 0; c < moduleCount; c++) {
      for (let r = 0; r < moduleCount - 6; r++) {
        if (grid[r][c] && !grid[r + 1][c] && grid[r + 2][c] && grid[r + 3][c] && grid[r + 4][c] && !grid[r + 5][c] && grid[r + 6][c]) lostPoint += 40;
      }
    }
    let darkCount = 0;
    for (let r = 0; r < moduleCount; r++) for (let c = 0; c < moduleCount; c++) if (grid[r][c]) darkCount += 1;
    lostPoint += Math.abs((100 * darkCount) / (moduleCount * moduleCount) - 50) / 5 * 10;

    for (let r = 0; r < moduleCount; r++) for (let c = 0; c < moduleCount; c++) modules[r][c] = grid[r][c] === true;
    if (!best || lostPoint < best.lost) best = { modules, lost: lostPoint };
  }

  return { size: moduleCount, modules: best!.modules };
}
