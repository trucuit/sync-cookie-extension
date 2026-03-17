import { nowIso } from './fixtures';

const subtle = globalThis.crypto?.subtle;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const AES_GCM_ALGORITHM = 'AES-GCM-256';
export const PBKDF2_HASH = 'SHA-256';
export const PBKDF2_ITERATIONS = 100_000;
export const AES_GCM_IV_BYTES = 12;
export const PBKDF2_SALT_BYTES = 16;
export const ENCRYPTED_MANIFEST_SCHEMA = 'pat-cookie-encrypted-v1';

function createCodeError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function ensureCrypto() {
  if (!subtle || !globalThis.crypto?.getRandomValues) {
    throw createCodeError('crypto.unavailable', 'Web Crypto API is not available in this runtime.');
  }

  return subtle;
}

function asUint8Array(value: unknown, fieldName: string) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  throw createCodeError('crypto.invalid_payload', `${fieldName} must be Uint8Array, ArrayBuffer, or base64 string.`);
}

function toBase64(value: ArrayBuffer | Uint8Array) {
  const bytes = asUint8Array(value, 'binary payload');
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return globalThis.btoa(binary);
}

function fromBase64(value: unknown, fieldName: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createCodeError('crypto.invalid_payload', `${fieldName} must be a non-empty base64 string.`);
  }

  let binary: string;
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

function normalizePassword(password: unknown, fieldName = 'password') {
  if (typeof password !== 'string' || !password.trim()) {
    throw createCodeError('crypto.invalid_password', `${fieldName} is required.`);
  }

  return password;
}

function normalizeIterations(iterations: unknown = PBKDF2_ITERATIONS) {
  const parsed = Number(iterations);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createCodeError('crypto.invalid_kdf_iterations', 'PBKDF2 iterations must be a positive integer.');
  }

  return parsed;
}

function randomBytes(length: number) {
  const array = new Uint8Array(length);
  globalThis.crypto.getRandomValues(array);
  return array;
}

function toBufferSource(value: Uint8Array | ArrayBuffer) {
  return value as unknown as BufferSource;
}

function normalizeIv(iv: unknown, { required = false }: { required?: boolean } = {}) {
  if (iv === undefined || iv === null) {
    if (required) {
      throw createCodeError('crypto.invalid_iv', 'IV is required.');
    }

    return randomBytes(AES_GCM_IV_BYTES);
  }

  const normalized = typeof iv === 'string' ? fromBase64(iv, 'iv') : asUint8Array(iv, 'iv');
  if (normalized.byteLength !== AES_GCM_IV_BYTES) {
    throw createCodeError('crypto.invalid_iv', `IV must be ${AES_GCM_IV_BYTES} bytes for AES-GCM.`);
  }

  return normalized;
}

function normalizeSalt(salt: unknown, { required = false }: { required?: boolean } = {}) {
  if (salt === undefined || salt === null) {
    if (required) {
      throw createCodeError('crypto.invalid_salt', 'salt is required.');
    }

    return randomBytes(PBKDF2_SALT_BYTES);
  }

  const normalized = typeof salt === 'string' ? fromBase64(salt, 'salt') : asUint8Array(salt, 'salt');
  if (normalized.byteLength < PBKDF2_SALT_BYTES) {
    throw createCodeError('crypto.invalid_salt', `salt must be at least ${PBKDF2_SALT_BYTES} bytes.`);
  }

  return normalized;
}

function checksumInputForPayload(payload: unknown) {
  if (typeof payload === 'string') {
    return payload;
  }

  if (payload && typeof payload === 'object') {
    return JSON.stringify(payload);
  }

  throw createCodeError('crypto.invalid_payload', 'payload must be a string or object for checksum calculation.');
}

type EncryptedPayload = {
  algorithm: string;
  iv: string;
  salt: string;
  ciphertext: string;
  kdf: {
    name: string;
    hash: string;
    iterations: number;
  };
};

function normalizeEncryptedPayload(encryptedPayload: unknown) {
  if (!encryptedPayload || typeof encryptedPayload !== 'object') {
    throw createCodeError('crypto.invalid_payload', 'encryptedPayload is required.');
  }

  const payload = encryptedPayload as {
    algorithm?: string;
    iv?: string;
    salt?: string;
    ciphertext?: string;
    kdf?: { iterations?: number };
  };

  const algorithm = payload.algorithm ?? AES_GCM_ALGORITHM;
  if (algorithm !== AES_GCM_ALGORITHM) {
    throw createCodeError('crypto.invalid_algorithm', `Unsupported algorithm ${algorithm}. Expected ${AES_GCM_ALGORITHM}.`);
  }

  const iv = normalizeIv(payload.iv, { required: true });
  const salt = normalizeSalt(payload.salt, { required: true });
  const ciphertext = fromBase64(payload.ciphertext, 'ciphertext');
  const iterations = normalizeIterations(payload.kdf?.iterations ?? PBKDF2_ITERATIONS);

  return {
    algorithm,
    iv,
    salt,
    ciphertext,
    iterations,
  };
}

async function digestSha256(input: string) {
  const hashBuffer = await ensureCrypto().digest('SHA-256', textEncoder.encode(input));
  const bytes = new Uint8Array(hashBuffer);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function computePayloadChecksum(payload: unknown) {
  const normalized = checksumInputForPayload(payload);
  const digest = await digestSha256(normalized);
  return `sha256:${digest}`;
}

export async function validateManifestChecksum(manifest: unknown) {
  if (!manifest || typeof manifest !== 'object') {
    throw createCodeError('crypto.invalid_manifest', 'manifest is required.');
  }

  const parsedManifest = manifest as { checksum?: string; payload?: unknown };
  if (typeof parsedManifest.checksum !== 'string' || !parsedManifest.checksum.startsWith('sha256:')) {
    throw createCodeError('crypto.invalid_manifest', 'manifest.checksum must be a sha256 checksum string.');
  }

  const calculated = await computePayloadChecksum(parsedManifest.payload);
  return calculated === parsedManifest.checksum;
}

export async function assertManifestChecksum(manifest: unknown) {
  const valid = await validateManifestChecksum(manifest);
  if (!valid) {
    throw createCodeError('crypto.checksum_mismatch', 'Manifest checksum mismatch. Payload may be tampered or corrupted.');
  }
}

export async function deriveAesGcmKeyFromPassword({
  password,
  salt,
  iterations = PBKDF2_ITERATIONS,
  usages = ['encrypt', 'decrypt'],
}: {
  password: string;
  salt?: string | ArrayBuffer | Uint8Array;
  iterations?: number;
  usages?: KeyUsage[];
}) {
  const normalizedPassword = normalizePassword(password);
  const normalizedSalt = normalizeSalt(salt);
  const normalizedIterations = normalizeIterations(iterations);

  const cryptoSubtle = ensureCrypto();
  const keyMaterial = await cryptoSubtle.importKey(
    'raw',
    textEncoder.encode(normalizedPassword),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const key = await cryptoSubtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: PBKDF2_HASH,
      salt: toBufferSource(normalizedSalt),
      iterations: normalizedIterations,
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    usages
  );

  return {
    key,
    salt: normalizedSalt,
    iterations: normalizedIterations,
  };
}

export async function encryptUtf8WithPassword({
  plaintext,
  password,
  salt,
  iv,
  iterations = PBKDF2_ITERATIONS,
}: {
  plaintext: string;
  password: string;
  salt?: string | ArrayBuffer | Uint8Array;
  iv?: string | ArrayBuffer | Uint8Array;
  iterations?: number;
}): Promise<EncryptedPayload> {
  if (typeof plaintext !== 'string') {
    throw createCodeError('crypto.invalid_payload', 'plaintext must be a UTF-8 string.');
  }

  const normalizedIv = normalizeIv(iv);
  const derived = await deriveAesGcmKeyFromPassword({
    password,
    salt,
    iterations,
    usages: ['encrypt'],
  });

  const ciphertext = await ensureCrypto().encrypt(
      {
        name: 'AES-GCM',
        iv: toBufferSource(normalizedIv),
      },
    derived.key,
    textEncoder.encode(plaintext)
  );

  return {
    algorithm: AES_GCM_ALGORITHM,
    iv: toBase64(normalizedIv),
    salt: toBase64(derived.salt),
    ciphertext: toBase64(ciphertext),
    kdf: {
      name: 'PBKDF2',
      hash: PBKDF2_HASH,
      iterations: derived.iterations,
    },
  };
}

export async function decryptUtf8WithPassword({
  encryptedPayload,
  password,
}: {
  encryptedPayload: EncryptedPayload;
  password: string;
}) {
  normalizePassword(password);
  const normalized = normalizeEncryptedPayload(encryptedPayload);

  const derived = await deriveAesGcmKeyFromPassword({
    password,
    salt: normalized.salt,
    iterations: normalized.iterations,
    usages: ['decrypt'],
  });

  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await ensureCrypto().decrypt(
      {
        name: 'AES-GCM',
        iv: toBufferSource(normalized.iv),
      },
      derived.key,
      toBufferSource(normalized.ciphertext)
    );
  } catch {
    throw createCodeError('crypto.invalid_password', 'Invalid password or corrupted ciphertext.');
  }

  return textDecoder.decode(plaintextBuffer);
}

export async function createEncryptedManifest({
  manifestPayload,
  password,
  version = 1,
  meta = {},
  iterations = PBKDF2_ITERATIONS,
  salt,
  iv,
}: {
  manifestPayload: unknown;
  password: string;
  version?: number;
  meta?: Record<string, unknown>;
  iterations?: number;
  salt?: string | ArrayBuffer | Uint8Array;
  iv?: string | ArrayBuffer | Uint8Array;
}) {
  if (!manifestPayload || typeof manifestPayload !== 'object') {
    throw createCodeError('crypto.invalid_manifest', 'manifestPayload object is required.');
  }

  if (!Number.isInteger(version) || version <= 0) {
    throw createCodeError('crypto.invalid_manifest', 'version must be a positive integer.');
  }

  const encryptedPayload = await encryptUtf8WithPassword({
    plaintext: JSON.stringify(manifestPayload),
    password,
    iterations,
    salt,
    iv,
  });

  const checksum = await computePayloadChecksum(encryptedPayload);

  return {
    version,
    payload: encryptedPayload,
    checksum,
    meta: {
      schema: ENCRYPTED_MANIFEST_SCHEMA,
      generatedAt: nowIso(),
      ...meta,
    },
  };
}

export async function decryptManifestPayload({
  manifest,
  password,
  validateChecksum = true,
}: {
  manifest: { payload: EncryptedPayload; checksum: string };
  password: string;
  validateChecksum?: boolean;
}) {
  if (!manifest || typeof manifest !== 'object') {
    throw createCodeError('crypto.invalid_manifest', 'manifest is required.');
  }

  if (validateChecksum) {
    await assertManifestChecksum(manifest);
  }

  const plaintext = await decryptUtf8WithPassword({
    encryptedPayload: manifest.payload,
    password,
  });

  try {
    return JSON.parse(plaintext);
  } catch {
    throw createCodeError('crypto.invalid_payload', 'Decrypted payload is not valid JSON.');
  }
}
