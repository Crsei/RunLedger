// Shared checksum primitives for archive containers. CRC-32 (IEEE, reflected)
// delegates to Bun's native implementation; CRC-64/XZ and CRC-16/ARC are
// table-driven so format modules never hand-roll per-bit loops. Format-owned
// oddballs (bzip2's MSB-first CRC-32, CAB's block checksum, cpio/tar sums)
// stay in their modules.

let CRC32_TABLE: Uint32Array | undefined;

/** 反射多项式 0xEDB88320 的查表（首次调用时构建）。 */
function crc32Table(): Uint32Array {
	if (CRC32_TABLE !== undefined) return CRC32_TABLE;
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) {
			value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	CRC32_TABLE = table;
	return table;
}

/**
 * CRC-32 (IEEE 802.3, reflected)。Chainable: 传入上一次的返回值作为 `seed`。
 *
 * 上游用 `Bun.hash.crc32`；RunLedger 是 node/bun 双运行时,这里改用等价的
 * 表驱动实现（与 zip/gzip 的 CRC-32 定义一致）,避免绑定单一运行时。
 */
export function crc32(bytes: Uint8Array, seed = 0): number {
	const table = crc32Table();
	let value = (seed ^ 0xffffffff) >>> 0;
	for (let index = 0; index < bytes.byteLength; index++) {
		value = (table[(value ^ bytes[index]!) & 0xff]! ^ (value >>> 8)) >>> 0;
	}
	return (value ^ 0xffffffff) >>> 0;
}

const CRC64_LO = new Uint32Array(256);
const CRC64_HI = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
	let lo = index;
	let hi = 0;
	for (let bit = 0; bit < 8; bit++) {
		const carry = (lo & 1) !== 0;
		lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
		hi >>>= 1;
		if (carry) {
			lo = (lo ^ 0xd7870f42) >>> 0;
			hi = (hi ^ 0xc96c5795) >>> 0;
		}
	}
	CRC64_LO[index] = lo;
	CRC64_HI[index] = hi;
}

/**
 * CRC-64/XZ (ECMA-182, reflected) as used by `.xz` block checks. Chainable
 * via `seed`. State is split into 32-bit halves so the hot loop stays on
 * fast integer paths instead of per-byte BigInt arithmetic.
 */
export function crc64(bytes: Uint8Array, seed = 0n): bigint {
	const initial = seed ^ 0xffffffffffffffffn;
	let lo = Number(initial & 0xffffffffn) >>> 0;
	let hi = Number((initial >> 32n) & 0xffffffffn) >>> 0;
	for (let index = 0; index < bytes.length; index++) {
		const slot = (lo ^ bytes[index]!) & 0xff;
		const nextLo = ((lo >>> 8) | ((hi & 0xff) << 24)) >>> 0;
		lo = (nextLo ^ CRC64_LO[slot]!) >>> 0;
		hi = ((hi >>> 8) ^ CRC64_HI[slot]!) >>> 0;
	}
	return ((BigInt(hi) << 32n) | BigInt(lo)) ^ 0xffffffffffffffffn;
}

const CRC16_TABLE = new Uint16Array(256);
for (let index = 0; index < 256; index++) {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? (value >>> 1) ^ 0xa001 : value >>> 1;
	CRC16_TABLE[index] = value;
}

/** CRC-16/ARC (reflected, poly 0xA001, init 0) as used by LZH member data and ARJ. */
export function crc16Arc(bytes: Uint8Array, seed = 0): number {
	let value = seed;
	for (let index = 0; index < bytes.length; index++) {
		value = ((value >>> 8) ^ CRC16_TABLE[(value ^ bytes[index]!) & 0xff]!) & 0xffff;
	}
	return value;
}
