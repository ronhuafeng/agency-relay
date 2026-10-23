const encoder = new TextEncoder();
const decoder = new TextDecoder();

const API_KEY_PREFIX_LENGTH = 18;

export function nowIso(now = new Date()): string {
  return now.toISOString();
}

export function addSecondsIso(seconds: number, now = new Date()): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

export function parseIsoMillis(value?: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function generateApiKey(): { plaintext: string; prefix: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const plaintext = `cfwd_${base64UrlEncode(bytes)}`;
  return { plaintext, prefix: keyPrefix(plaintext) };
}

export function keyPrefix(plaintext: string): string {
  return plaintext.slice(0, API_KEY_PREFIX_LENGTH);
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToHex(new Uint8Array(signature));
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export function timingSafeEqualHex(left: string, right: string): boolean {
  return timingSafeEqualBytes(hexToBytes(left), hexToBytes(right));
}

export function timingSafeEqualString(left: string, right: string): boolean {
  return timingSafeEqualBytes(encoder.encode(left), encoder.encode(right));
}

/** Stored Runtime OAuth hashes. The prefix is part of the persisted key. */
export function runtimeOAuthMaterialHash(pepper: string, value: string): Promise<string> {
  return hmacSha256Hex(pepper, `runtime-oauth\0${value}`);
}

export async function encryptJson(secret: string, value: unknown) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await aesKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(value))
  );
  return {
    kid: "v1" as const,
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext))
  };
}

export async function decryptJson<T>(secret: string, encrypted: { iv: string; ciphertext: string }): Promise<T> {
  const key = await aesKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(encrypted.iv) },
    key,
    base64UrlDecode(encrypted.ciphertext)
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || /[^0-9a-f]/i.test(value)) {
    return new Uint8Array();
  }
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export async function pkceChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Accepts an absolute callback URL or a raw query string. */
export function parseOAuthCallback(callbackUrl?: string | null): { code?: string; state?: string } {
  if (!callbackUrl?.trim()) {
    return {};
  }
  try {
    const url = new URL(callbackUrl.trim());
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined
    };
  } catch {
    try {
      const params = new URLSearchParams(callbackUrl.includes("?") ? callbackUrl.split("?")[1] : callbackUrl);
      return {
        code: params.get("code") ?? undefined,
        state: params.get("state") ?? undefined
      };
    } catch {
      return {};
    }
  }
}

export function secureJitterMillis(maxExclusive: number): number {
  if (maxExclusive <= 0) {
    return 0;
  }
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] % maxExclusive;
}
