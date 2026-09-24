/**
 * A minimal, pure-TypeScript DES implementation (FIPS 46-3), used only for
 * VNC Authentication's challenge/response step.
 *
 * Node's OpenSSL 3 build does not ship single-DES in its default provider
 * (`error:0308010C:digital envelope routines::unsupported`), so this exists
 * to avoid a native dependency for two 8-byte block encryptions per
 * thumbnail capture. It implements exactly what VNC Authentication needs --
 * single-block ECB encryption with a caller-supplied 8-byte key -- not a
 * general-purpose DES/3DES library.
 *
 * Tables are the standard FIPS 46-3 permutation/substitution tables,
 * expressed 1-indexed (bit 1 = MSB of a 64-bit block) as the spec itself
 * does; `permute` below adjusts for 0-indexed array access.
 */

/** Initial permutation. */
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64,
  56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53,
  45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

/** Final permutation (inverse of IP). */
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37,
  5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2,
  42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

/** Permuted choice 1: 64-bit key (incl. parity bits) -> 56 bits. */
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60,
  52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21,
  13, 5, 28, 20, 12, 4,
];

/** Permuted choice 2: 56-bit rotated key -> 48-bit round subkey. */
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52,
  31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

/** Per-round left-rotation amount for the C/D key halves. */
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

/** Expansion permutation: 32-bit half-block -> 48 bits. */
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18,
  19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];

/** Post-S-box permutation. */
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13,
  30, 6, 22, 11, 4, 25,
];

const S_BOXES: number[][] = [
  // S1
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11,
    9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5,
    11, 3, 14, 10, 0, 6, 13,
  ],
  // S2
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10,
    6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2,
    11, 6, 7, 12, 0, 5, 14, 9,
  ],
  // S3
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14,
    12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7,
    4, 15, 14, 3, 11, 5, 2, 12,
  ],
  // S4
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12,
    1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8,
    9, 4, 5, 11, 12, 7, 2, 14,
  ],
  // S5
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10,
    3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13,
    6, 15, 0, 9, 10, 4, 5, 3,
  ],
  // S6
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14,
    0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10,
    11, 14, 1, 7, 6, 0, 8, 13,
  ],
  // S7
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12,
    2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7,
    9, 5, 0, 15, 14, 2, 3, 12,
  ],
  // S8
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11,
    0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13,
    15, 12, 9, 0, 3, 5, 6, 11,
  ],
];

/** A block of bits represented as a plain array of 0/1 for clarity over raw bit-twiddling. */
type Bits = number[];

function bytesToBits(buf: Buffer): Bits {
  const bits: Bits = new Array(buf.length * 8);
  for (let i = 0; i < buf.length; i++) {
    for (let b = 0; b < 8; b++) {
      // MSB first, matching FIPS 46-3's 1-indexed-from-the-left numbering.
      bits[i * 8 + b] = (buf[i]! >> (7 - b)) & 1;
    }
  }
  return bits;
}

function bitsToBytes(bits: Bits): Buffer {
  const out = Buffer.alloc(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | (bits[i * 8 + b] ?? 0);
    }
    out[i] = byte;
  }
  return out;
}

/** Applies a 1-indexed permutation table (`table[i]` = 1-based source bit position for output bit `i`). */
function permute(input: Bits, table: readonly number[]): Bits {
  return table.map((pos) => input[pos - 1]!);
}

function leftRotate(bits: Bits, amount: number): Bits {
  const n = bits.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = bits[(i + amount) % n];
  return out;
}

function xorBits(a: Bits, b: Bits): Bits {
  return a.map((v, i) => v ^ b[i]!);
}

/** Expands the 56-bit PC1 output into the 16 round subkeys (each 48 bits), per the standard key schedule. */
function keySchedule(key8: Buffer): Bits[] {
  const keyBits = bytesToBits(key8);
  const pc1 = permute(keyBits, PC1);
  let c = pc1.slice(0, 28);
  let d = pc1.slice(28, 56);

  const subkeys: Bits[] = [];
  for (let round = 0; round < 16; round++) {
    c = leftRotate(c, SHIFTS[round]!);
    d = leftRotate(d, SHIFTS[round]!);
    subkeys.push(permute([...c, ...d], PC2));
  }
  return subkeys;
}

function sBoxSubstitute(input48: Bits): Bits {
  const out: Bits = [];
  for (let s = 0; s < 8; s++) {
    const chunk = input48.slice(s * 6, s * 6 + 6);
    const row = (chunk[0]! << 1) | chunk[5]!;
    const col = (chunk[1]! << 3) | (chunk[2]! << 2) | (chunk[3]! << 1) | chunk[4]!;
    const value = S_BOXES[s]![row * 16 + col]!;
    for (let b = 3; b >= 0; b--) out.push((value >> b) & 1);
  }
  return out;
}

function feistel(half32: Bits, subkey48: Bits): Bits {
  const expanded = permute(half32, E);
  const mixed = xorBits(expanded, subkey48);
  const substituted = sBoxSubstitute(mixed);
  return permute(substituted, P);
}

/**
 * Encrypts exactly one 8-byte block with one 8-byte key, ECB-style (no
 * chaining -- callers encrypting multiple blocks with the same key, as VNC
 * Authentication does, call this once per block).
 */
export function desEncryptBlock(key8: Buffer, block8: Buffer): Buffer {
  if (key8.length !== 8) throw new Error('DES key must be 8 bytes');
  if (block8.length !== 8) throw new Error('DES block must be 8 bytes');

  const subkeys = keySchedule(key8);
  const ip = permute(bytesToBits(block8), IP);
  let l = ip.slice(0, 32);
  let r = ip.slice(32, 64);

  for (let round = 0; round < 16; round++) {
    const newR = xorBits(l, feistel(r, subkeys[round]!));
    l = r;
    r = newR;
  }

  // Final swap is undone here (R16,L16), then FP.
  const preOutput = [...r, ...l];
  return bitsToBytes(permute(preOutput, FP));
}

/**
 * Reverses the bits of a single byte -- the well-known VNC quirk: RFC 6143
 * doesn't document it, but every real VNC server/client mangles each key
 * byte this way before using it as a DES key (a historical artifact of the
 * original AT&T implementation's bit ordering).
 */
export function reverseBits(byte: number): number {
  let result = 0;
  let b = byte;
  for (let i = 0; i < 8; i++) {
    result = (result << 1) | (b & 1);
    b >>= 1;
  }
  return result;
}

/**
 * Builds the 8-byte DES key VNC Authentication uses from a password/ticket
 * string: its first 8 bytes (zero-padded if shorter, truncated if longer),
 * each bit-reversed.
 */
export function vncDesKey(password: string): Buffer {
  const raw = Buffer.from(password, 'latin1');
  const key = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    key[i] = i < raw.length ? reverseBits(raw[i]!) : 0;
  }
  return key;
}

/**
 * Computes the 16-byte VNC Authentication response: the 16-byte server
 * challenge, encrypted as two independent 8-byte ECB blocks under the
 * password-derived (bit-reversed) DES key.
 */
export function vncAuthResponse(password: string, challenge16: Buffer): Buffer {
  if (challenge16.length !== 16) throw new Error('VNC challenge must be 16 bytes');
  const key = vncDesKey(password);
  return Buffer.concat([
    desEncryptBlock(key, challenge16.subarray(0, 8)),
    desEncryptBlock(key, challenge16.subarray(8, 16)),
  ]);
}
