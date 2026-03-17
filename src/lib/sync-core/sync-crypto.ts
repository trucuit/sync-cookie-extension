/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

/**
 * Sync Crypto — AES-256-GCM encryption/decryption with PBKDF2 key derivation.
 * Extracted from gist-sync-crypto.ts, standalone with no external imports.
 */

const subtle = globalThis.crypto?.subtle;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const AES_GCM_ALGORITHM = 'AES-GCM-256';
export const PBKDF2_HASH = 'SHA-256';
export const PBKDF2_ITERATIONS = 100_000;
export const AES_GCM_IV_BYTES = 12;
export const PBKDF2_SALT_BYTES = 16;

function createCodeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureCrypto() {
  if (!subtle || !globalThis.crypto?.getRandomValues) {
    throw createCodeError('crypto.unavailable', 'Web Crypto API is not available in this runtime.');
  }
  return subtle;
}

function asUint8Array(value, fieldName) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw createCodeError('crypto.invalid_payload', `${fieldName} must be Uint8Array, ArrayBuffer, or base64 string.`);
}

function toBase64(value) {
  const bytes = asUint8Array(value, 'binary payload');
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
}

function fromBase64(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createCodeError('crypto.invalid_payload', `${fieldName} must be a non-empty base64 string.`);
  }

  let binary;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw createCodeError('crypto.invalid_payload', `${fieldName} is not valid base64.`);
  }

  if (binary.length === 0) {
    throw createCodeError('crypto.invalid_payload', `${fieldName} must not decode to empty bytes.`);
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizePassword(password, fieldName = 'password') {
  if (typeof password !== 'string' || !password.trim()) {
    throw createCodeError('crypto.invalid_password', `${fieldName} is required.`);
  }
  return password;
}

function normalizeIterations(iterations = PBKDF2_ITERATIONS) {
  const parsed = Number(iterations);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createCodeError('crypto.invalid_kdf_iterations', 'PBKDF2 iterations must be a positive integer.');
  }
  return parsed;
}

function randomBytes(length) {
  const array = new Uint8Array(length);
  globalThis.crypto.getRandomValues(array);
  return array;
}

function toBufferSource(value) {
  return value;
}

function normalizeIv(iv, { required = false } = {}) {
  if (iv === undefined || iv === null) {
    if (required) throw createCodeError('crypto.invalid_iv', 'IV is required.');
    return randomBytes(AES_GCM_IV_BYTES);
  }
  const normalized = typeof iv === 'string' ? fromBase64(iv, 'iv') : asUint8Array(iv, 'iv');
  if (normalized.byteLength !== AES_GCM_IV_BYTES) {
    throw createCodeError('crypto.invalid_iv', `IV must be ${AES_GCM_IV_BYTES} bytes for AES-GCM.`);
  }
  return normalized;
}

function normalizeSalt(salt, { required = false } = {}) {
  if (salt === undefined || salt === null) {
    if (required) throw createCodeError('crypto.invalid_salt', 'salt is required.');
    return randomBytes(PBKDF2_SALT_BYTES);
  }
  const normalized = typeof salt === 'string' ? fromBase64(salt, 'salt') : asUint8Array(salt, 'salt');
  if (normalized.byteLength < PBKDF2_SALT_BYTES) {
    throw createCodeError('crypto.invalid_salt', `salt must be at least ${PBKDF2_SALT_BYTES} bytes.`);
  }
  return normalized;
}

function normalizeEncryptedPayload(encryptedPayload) {
  if (!encryptedPayload || typeof encryptedPayload !== 'object') {
    throw createCodeError('crypto.invalid_payload', 'encryptedPayload is required.');
  }

  const payload = encryptedPayload;
  const algorithm = payload.algorithm ?? AES_GCM_ALGORITHM;
  if (algorithm !== AES_GCM_ALGORITHM) {
    throw createCodeError('crypto.invalid_algorithm', `Unsupported algorithm ${algorithm}. Expected ${AES_GCM_ALGORITHM}.`);
  }

  const iv = normalizeIv(payload.iv, { required: true });
  const salt = normalizeSalt(payload.salt, { required: true });
  const ciphertext = fromBase64(payload.ciphertext, 'ciphertext');
  const iterations = normalizeIterations(payload.kdf?.iterations ?? PBKDF2_ITERATIONS);

  return { algorithm, iv, salt, ciphertext, iterations };
}

async function deriveAesGcmKeyFromPassword({ password, salt, iterations = PBKDF2_ITERATIONS, usages = ['encrypt', 'decrypt'] }) {
  const normalizedPassword = normalizePassword(password);
  const normalizedSalt = normalizeSalt(salt);
  const normalizedIterations = normalizeIterations(iterations);

  const cryptoSubtle = ensureCrypto();
  const keyMaterial = await cryptoSubtle.importKey('raw', textEncoder.encode(normalizedPassword), 'PBKDF2', false, ['deriveKey']);

  const key = await cryptoSubtle.deriveKey(
    { name: 'PBKDF2', hash: PBKDF2_HASH, salt: toBufferSource(normalizedSalt), iterations: normalizedIterations },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );

  return { key, salt: normalizedSalt, iterations: normalizedIterations };
}

export async function encryptUtf8WithPassword({ plaintext, password, salt, iv, iterations = PBKDF2_ITERATIONS }: {
  plaintext: string;
  password: string;
  salt?: string | ArrayBuffer | Uint8Array;
  iv?: string | ArrayBuffer | Uint8Array;
  iterations?: number;
}) {
  if (typeof plaintext !== 'string') {
    throw createCodeError('crypto.invalid_payload', 'plaintext must be a UTF-8 string.');
  }

  const normalizedIv = normalizeIv(iv);
  const derived = await deriveAesGcmKeyFromPassword({ password, salt, iterations, usages: ['encrypt'] });

  const ciphertext = await ensureCrypto().encrypt(
    { name: 'AES-GCM', iv: toBufferSource(normalizedIv) },
    derived.key,
    textEncoder.encode(plaintext)
  );

  return {
    algorithm: AES_GCM_ALGORITHM,
    iv: toBase64(normalizedIv),
    salt: toBase64(derived.salt),
    ciphertext: toBase64(ciphertext),
    kdf: { name: 'PBKDF2', hash: PBKDF2_HASH, iterations: derived.iterations },
  };
}

export async function decryptUtf8WithPassword({ encryptedPayload, password }) {
  normalizePassword(password);
  const normalized = normalizeEncryptedPayload(encryptedPayload);

  const derived = await deriveAesGcmKeyFromPassword({
    password,
    salt: normalized.salt,
    iterations: normalized.iterations,
    usages: ['decrypt'],
  });

  let plaintextBuffer;
  try {
    plaintextBuffer = await ensureCrypto().decrypt(
      { name: 'AES-GCM', iv: toBufferSource(normalized.iv) },
      derived.key,
      toBufferSource(normalized.ciphertext)
    );
  } catch {
    throw createCodeError('crypto.invalid_password', 'Invalid password or corrupted ciphertext.');
  }

  return textDecoder.decode(plaintextBuffer);
}
