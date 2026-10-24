import { createHash } from 'node:crypto';

// Direcciones TRON: 0x41 + 20 bytes, en Base58Check (alfabeto de Bitcoin, suma de control
// con doble SHA-256). Los eventos de los contratos traen la dirección en hexadecimal.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PREFIX = 0x41;

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();
const checksum = (payload: Buffer) => sha256(sha256(payload)).subarray(0, 4);

function encode58(bytes: Buffer): string {
  let n = BigInt('0x' + (bytes.toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

function decode58(s: string): Buffer | null {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0;
  for (const ch of s) {
    if (ch !== '1') break;
    zeros++;
  }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

/** Dirección Base58Check válida de TRON: 25 bytes, prefijo 0x41 y suma de control correcta. */
export function isValidTronAddress(address: string): boolean {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  const raw = decode58(address);
  if (!raw || raw.length !== 25 || raw[0] !== PREFIX) return false;
  return checksum(raw.subarray(0, 21)).equals(raw.subarray(21));
}

/** 20 bytes (40 hex) o 21 bytes con prefijo 41 (42 hex) → dirección Base58Check. null si el formato no es ese. */
export function tronHexToBase58(hex: string): string | null {
  const h = hex.trim().replace(/^0x/i, '').toLowerCase();
  let full: string;
  if (/^[0-9a-f]{40}$/.test(h)) full = '41' + h;
  else if (/^41[0-9a-f]{40}$/.test(h)) full = h;
  else return null;
  const payload = Buffer.from(full, 'hex');
  return encode58(Buffer.concat([payload, checksum(payload)]));
}

/** Dirección Base58Check → 21 bytes en hexadecimal (con el prefijo 41). null si no es válida. */
export function tronBase58ToHex(address: string): string | null {
  if (!isValidTronAddress(address)) return null;
  return decode58(address)!.subarray(0, 21).toString('hex');
}
