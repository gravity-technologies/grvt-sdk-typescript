// keccak256 for the signing hot path. Every EIP-712 hash is a handful of keccak calls over a few
// hundred bytes, and this unrolled permutation is several times faster than @noble/hashes' looped
// one. The output is checked against @noble/hashes in test/keccak.test.ts.

const RCL = new Int32Array([
  0x1, 0x8082, 0x808a, 0x80008000, 0x808b, 0x80000001, 0x80008081, 0x8009, 0x8a, 0x88, 0x80008009,
  0x8000000a, 0x8000808b, 0x8b, 0x8089, 0x8003, 0x8002, 0x80, 0x800a, 0x8000000a, 0x80008081,
  0x8080, 0x80000001, 0x80008008,
]);
const RCH = new Int32Array([
  0x0, 0x0, 0x80000000, 0x80000000, 0x0, 0x0, 0x80000000, 0x80000000, 0x0, 0x0, 0x0, 0x0, 0x0,
  0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x0, 0x80000000, 0x80000000,
  0x80000000, 0x0, 0x80000000,
]);

/** keccak-f[1600] on 25 lanes stored as 50 little-endian 32-bit words (lo, hi). */
function permute(s: Int32Array): void {
  let a0l = s[0]!,
    a0h = s[1]!,
    a1l = s[2]!,
    a1h = s[3]!,
    a2l = s[4]!,
    a2h = s[5]!,
    a3l = s[6]!,
    a3h = s[7]!,
    a4l = s[8]!,
    a4h = s[9]!,
    a5l = s[10]!,
    a5h = s[11]!,
    a6l = s[12]!,
    a6h = s[13]!,
    a7l = s[14]!,
    a7h = s[15]!,
    a8l = s[16]!,
    a8h = s[17]!,
    a9l = s[18]!,
    a9h = s[19]!,
    a10l = s[20]!,
    a10h = s[21]!,
    a11l = s[22]!,
    a11h = s[23]!,
    a12l = s[24]!,
    a12h = s[25]!,
    a13l = s[26]!,
    a13h = s[27]!,
    a14l = s[28]!,
    a14h = s[29]!,
    a15l = s[30]!,
    a15h = s[31]!,
    a16l = s[32]!,
    a16h = s[33]!,
    a17l = s[34]!,
    a17h = s[35]!,
    a18l = s[36]!,
    a18h = s[37]!,
    a19l = s[38]!,
    a19h = s[39]!,
    a20l = s[40]!,
    a20h = s[41]!,
    a21l = s[42]!,
    a21h = s[43]!,
    a22l = s[44]!,
    a22h = s[45]!,
    a23l = s[46]!,
    a23h = s[47]!,
    a24l = s[48]!,
    a24h = s[49]!;
  for (let r = 0; r < 24; r++) {
    const c0l = a0l ^ a5l ^ a10l ^ a15l ^ a20l;
    const c0h = a0h ^ a5h ^ a10h ^ a15h ^ a20h;
    const c1l = a1l ^ a6l ^ a11l ^ a16l ^ a21l;
    const c1h = a1h ^ a6h ^ a11h ^ a16h ^ a21h;
    const c2l = a2l ^ a7l ^ a12l ^ a17l ^ a22l;
    const c2h = a2h ^ a7h ^ a12h ^ a17h ^ a22h;
    const c3l = a3l ^ a8l ^ a13l ^ a18l ^ a23l;
    const c3h = a3h ^ a8h ^ a13h ^ a18h ^ a23h;
    const c4l = a4l ^ a9l ^ a14l ^ a19l ^ a24l;
    const c4h = a4h ^ a9h ^ a14h ^ a19h ^ a24h;
    const d0l = c4l ^ ((c1l << 1) | (c1h >>> 31));
    const d0h = c4h ^ ((c1h << 1) | (c1l >>> 31));
    const d1l = c0l ^ ((c2l << 1) | (c2h >>> 31));
    const d1h = c0h ^ ((c2h << 1) | (c2l >>> 31));
    const d2l = c1l ^ ((c3l << 1) | (c3h >>> 31));
    const d2h = c1h ^ ((c3h << 1) | (c3l >>> 31));
    const d3l = c2l ^ ((c4l << 1) | (c4h >>> 31));
    const d3h = c2h ^ ((c4h << 1) | (c4l >>> 31));
    const d4l = c3l ^ ((c0l << 1) | (c0h >>> 31));
    const d4h = c3h ^ ((c0h << 1) | (c0l >>> 31));
    const t0l = a0l ^ d0l;
    const t0h = a0h ^ d0h;
    const t5l = a5l ^ d0l;
    const t5h = a5h ^ d0h;
    const t10l = a10l ^ d0l;
    const t10h = a10h ^ d0h;
    const t15l = a15l ^ d0l;
    const t15h = a15h ^ d0h;
    const t20l = a20l ^ d0l;
    const t20h = a20h ^ d0h;
    const t1l = a1l ^ d1l;
    const t1h = a1h ^ d1h;
    const t6l = a6l ^ d1l;
    const t6h = a6h ^ d1h;
    const t11l = a11l ^ d1l;
    const t11h = a11h ^ d1h;
    const t16l = a16l ^ d1l;
    const t16h = a16h ^ d1h;
    const t21l = a21l ^ d1l;
    const t21h = a21h ^ d1h;
    const t2l = a2l ^ d2l;
    const t2h = a2h ^ d2h;
    const t7l = a7l ^ d2l;
    const t7h = a7h ^ d2h;
    const t12l = a12l ^ d2l;
    const t12h = a12h ^ d2h;
    const t17l = a17l ^ d2l;
    const t17h = a17h ^ d2h;
    const t22l = a22l ^ d2l;
    const t22h = a22h ^ d2h;
    const t3l = a3l ^ d3l;
    const t3h = a3h ^ d3h;
    const t8l = a8l ^ d3l;
    const t8h = a8h ^ d3h;
    const t13l = a13l ^ d3l;
    const t13h = a13h ^ d3h;
    const t18l = a18l ^ d3l;
    const t18h = a18h ^ d3h;
    const t23l = a23l ^ d3l;
    const t23h = a23h ^ d3h;
    const t4l = a4l ^ d4l;
    const t4h = a4h ^ d4h;
    const t9l = a9l ^ d4l;
    const t9h = a9h ^ d4h;
    const t14l = a14l ^ d4l;
    const t14h = a14h ^ d4h;
    const t19l = a19l ^ d4l;
    const t19h = a19h ^ d4h;
    const t24l = a24l ^ d4l;
    const t24h = a24h ^ d4h;
    const b0l = t0l;
    const b0h = t0h;
    const b1l = (t6h << 12) | (t6l >>> 20);
    const b1h = (t6l << 12) | (t6h >>> 20);
    const b2l = (t12h << 11) | (t12l >>> 21);
    const b2h = (t12l << 11) | (t12h >>> 21);
    const b3l = (t18l << 21) | (t18h >>> 11);
    const b3h = (t18h << 21) | (t18l >>> 11);
    const b4l = (t24l << 14) | (t24h >>> 18);
    const b4h = (t24h << 14) | (t24l >>> 18);
    const b5l = (t3l << 28) | (t3h >>> 4);
    const b5h = (t3h << 28) | (t3l >>> 4);
    const b6l = (t9l << 20) | (t9h >>> 12);
    const b6h = (t9h << 20) | (t9l >>> 12);
    const b7l = (t10l << 3) | (t10h >>> 29);
    const b7h = (t10h << 3) | (t10l >>> 29);
    const b8l = (t16h << 13) | (t16l >>> 19);
    const b8h = (t16l << 13) | (t16h >>> 19);
    const b9l = (t22h << 29) | (t22l >>> 3);
    const b9h = (t22l << 29) | (t22h >>> 3);
    const b10l = (t1l << 1) | (t1h >>> 31);
    const b10h = (t1h << 1) | (t1l >>> 31);
    const b11l = (t7l << 6) | (t7h >>> 26);
    const b11h = (t7h << 6) | (t7l >>> 26);
    const b12l = (t13l << 25) | (t13h >>> 7);
    const b12h = (t13h << 25) | (t13l >>> 7);
    const b13l = (t19l << 8) | (t19h >>> 24);
    const b13h = (t19h << 8) | (t19l >>> 24);
    const b14l = (t20l << 18) | (t20h >>> 14);
    const b14h = (t20h << 18) | (t20l >>> 14);
    const b15l = (t4l << 27) | (t4h >>> 5);
    const b15h = (t4h << 27) | (t4l >>> 5);
    const b16l = (t5h << 4) | (t5l >>> 28);
    const b16h = (t5l << 4) | (t5h >>> 28);
    const b17l = (t11l << 10) | (t11h >>> 22);
    const b17h = (t11h << 10) | (t11l >>> 22);
    const b18l = (t17l << 15) | (t17h >>> 17);
    const b18h = (t17h << 15) | (t17l >>> 17);
    const b19l = (t23h << 24) | (t23l >>> 8);
    const b19h = (t23l << 24) | (t23h >>> 8);
    const b20l = (t2h << 30) | (t2l >>> 2);
    const b20h = (t2l << 30) | (t2h >>> 2);
    const b21l = (t8h << 23) | (t8l >>> 9);
    const b21h = (t8l << 23) | (t8h >>> 9);
    const b22l = (t14h << 7) | (t14l >>> 25);
    const b22h = (t14l << 7) | (t14h >>> 25);
    const b23l = (t15h << 9) | (t15l >>> 23);
    const b23h = (t15l << 9) | (t15h >>> 23);
    const b24l = (t21l << 2) | (t21h >>> 30);
    const b24h = (t21h << 2) | (t21l >>> 30);
    a0l = b0l ^ (~b1l & b2l) ^ RCL[r]!;
    a0h = b0h ^ (~b1h & b2h) ^ RCH[r]!;
    a1l = b1l ^ (~b2l & b3l);
    a1h = b1h ^ (~b2h & b3h);
    a2l = b2l ^ (~b3l & b4l);
    a2h = b2h ^ (~b3h & b4h);
    a3l = b3l ^ (~b4l & b0l);
    a3h = b3h ^ (~b4h & b0h);
    a4l = b4l ^ (~b0l & b1l);
    a4h = b4h ^ (~b0h & b1h);
    a5l = b5l ^ (~b6l & b7l);
    a5h = b5h ^ (~b6h & b7h);
    a6l = b6l ^ (~b7l & b8l);
    a6h = b6h ^ (~b7h & b8h);
    a7l = b7l ^ (~b8l & b9l);
    a7h = b7h ^ (~b8h & b9h);
    a8l = b8l ^ (~b9l & b5l);
    a8h = b8h ^ (~b9h & b5h);
    a9l = b9l ^ (~b5l & b6l);
    a9h = b9h ^ (~b5h & b6h);
    a10l = b10l ^ (~b11l & b12l);
    a10h = b10h ^ (~b11h & b12h);
    a11l = b11l ^ (~b12l & b13l);
    a11h = b11h ^ (~b12h & b13h);
    a12l = b12l ^ (~b13l & b14l);
    a12h = b12h ^ (~b13h & b14h);
    a13l = b13l ^ (~b14l & b10l);
    a13h = b13h ^ (~b14h & b10h);
    a14l = b14l ^ (~b10l & b11l);
    a14h = b14h ^ (~b10h & b11h);
    a15l = b15l ^ (~b16l & b17l);
    a15h = b15h ^ (~b16h & b17h);
    a16l = b16l ^ (~b17l & b18l);
    a16h = b16h ^ (~b17h & b18h);
    a17l = b17l ^ (~b18l & b19l);
    a17h = b17h ^ (~b18h & b19h);
    a18l = b18l ^ (~b19l & b15l);
    a18h = b18h ^ (~b19h & b15h);
    a19l = b19l ^ (~b15l & b16l);
    a19h = b19h ^ (~b15h & b16h);
    a20l = b20l ^ (~b21l & b22l);
    a20h = b20h ^ (~b21h & b22h);
    a21l = b21l ^ (~b22l & b23l);
    a21h = b21h ^ (~b22h & b23h);
    a22l = b22l ^ (~b23l & b24l);
    a22h = b22h ^ (~b23h & b24h);
    a23l = b23l ^ (~b24l & b20l);
    a23h = b23h ^ (~b24h & b20h);
    a24l = b24l ^ (~b20l & b21l);
    a24h = b24h ^ (~b20h & b21h);
  }
  s[0] = a0l;
  s[1] = a0h;
  s[2] = a1l;
  s[3] = a1h;
  s[4] = a2l;
  s[5] = a2h;
  s[6] = a3l;
  s[7] = a3h;
  s[8] = a4l;
  s[9] = a4h;
  s[10] = a5l;
  s[11] = a5h;
  s[12] = a6l;
  s[13] = a6h;
  s[14] = a7l;
  s[15] = a7h;
  s[16] = a8l;
  s[17] = a8h;
  s[18] = a9l;
  s[19] = a9h;
  s[20] = a10l;
  s[21] = a10h;
  s[22] = a11l;
  s[23] = a11h;
  s[24] = a12l;
  s[25] = a12h;
  s[26] = a13l;
  s[27] = a13h;
  s[28] = a14l;
  s[29] = a14h;
  s[30] = a15l;
  s[31] = a15h;
  s[32] = a16l;
  s[33] = a16h;
  s[34] = a17l;
  s[35] = a17h;
  s[36] = a18l;
  s[37] = a18h;
  s[38] = a19l;
  s[39] = a19h;
  s[40] = a20l;
  s[41] = a20h;
  s[42] = a21l;
  s[43] = a21h;
  s[44] = a22l;
  s[45] = a22h;
  s[46] = a23l;
  s[47] = a23h;
  s[48] = a24l;
  s[49] = a24h;
}

const RATE = 136;
const STATE = new Int32Array(50);

function absorbBlock(s: Int32Array, data: Uint8Array, off: number): void {
  for (let w = 0; w < 34; w++) {
    const o = off + w * 4;
    s[w]! ^= data[o]! | (data[o + 1]! << 8) | (data[o + 2]! << 16) | (data[o + 3]! << 24);
  }
  permute(s);
}

/** keccak256(data[0..len]) into out[at..at+32]. */
export function keccak256Into(data: Uint8Array, len: number, out: Uint8Array, at: number): void {
  const s = STATE;
  s.fill(0);
  let off = 0;
  for (; off + RATE <= len; off += RATE) absorbBlock(s, data, off);
  const rest = len - off;
  for (let i = 0; i < rest; i++) {
    const w = i >> 2;
    s[w]! ^= data[off + i]! << ((i & 3) * 8);
  }
  s[rest >> 2]! ^= 0x01 << ((rest & 3) * 8);
  s[33]! ^= 0x80 << 24;
  permute(s);
  for (let w = 0; w < 8; w++) {
    const x = s[w]!;
    const o = at + w * 4;
    out[o] = x;
    out[o + 1] = x >>> 8;
    out[o + 2] = x >>> 16;
    out[o + 3] = x >>> 24;
  }
}

/** keccak256 of all of `data`, as a new 32-byte array. */
export function keccak256Bytes(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  keccak256Into(data, data.length, out, 0);
  return out;
}
