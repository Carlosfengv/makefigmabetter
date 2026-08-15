/**
 * SHA-256 with a WebCrypto fast path.
 *
 * The development editor is intentionally usable from a plain-HTTP LAN URL.
 * Browsers do not expose `crypto.subtle` in that context, so hash generation
 * must not turn an otherwise accepted local edit into a transient engine error.
 */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number) { return (value >>> bits) | (value << (32 - bits)); }

/** Exported for deterministic coverage of the non-secure-context path. */
export function sha256Fallback(input: Uint8Array): Uint8Array {
  const bitLength = input.byteLength * 8;
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.byteLength] = 0x80;
  const length = BigInt(bitLength);
  for (let index = 0; index < 8; index += 1) bytes[paddedLength - 1 - index] = Number((length >> BigInt(index * 8)) & 0xffn);

  let a0 = 0x6a09e667; let b0 = 0xbb67ae85; let c0 = 0x3c6ef372; let d0 = 0xa54ff53a;
  let e0 = 0x510e527f; let f0 = 0x9b05688c; let g0 = 0x1f83d9ab; let h0 = 0x5be0cd19;
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      schedule[index] = (bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3];
    }
    for (let index = 16; index < 64; index += 1) {
      const lower0 = rotateRight(schedule[index - 15], 7) ^ rotateRight(schedule[index - 15], 18) ^ (schedule[index - 15] >>> 3);
      const lower1 = rotateRight(schedule[index - 2], 17) ^ rotateRight(schedule[index - 2], 19) ^ (schedule[index - 2] >>> 10);
      schedule[index] = (schedule[index - 16] + lower0 + schedule[index - 7] + lower1) >>> 0;
    }
    let a = a0; let b = b0; let c = c0; let d = d0; let e = e0; let f = f0; let g = g0; let h = h0;
    for (let index = 0; index < 64; index += 1) {
      const upper1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + upper1 + choice + ROUND_CONSTANTS[index] + schedule[index]) >>> 0;
      const upper0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (upper0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temporary1) >>> 0; d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    e0 = (e0 + e) >>> 0; f0 = (f0 + f) >>> 0; g0 = (g0 + g) >>> 0; h0 = (h0 + h) >>> 0;
  }
  const output = new Uint8Array(32);
  [a0, b0, c0, d0, e0, f0, g0, h0].forEach((value, index) => {
    output[index * 4] = value >>> 24;
    output[index * 4 + 1] = value >>> 16;
    output[index * 4 + 2] = value >>> 8;
    output[index * 4 + 3] = value;
  });
  return output;
}

export async function sha256Bytes(input: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const bytes = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return new Uint8Array(await subtle.digest("SHA-256", bytes));
  return sha256Fallback(bytes);
}

export async function sha256Hex(input: Uint8Array | ArrayBuffer): Promise<string> {
  return Array.from(await sha256Bytes(input), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
