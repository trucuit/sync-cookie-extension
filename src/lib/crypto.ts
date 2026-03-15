/**
 * Crypto utilities for encrypting/decrypting cookie data
 * Uses Web Crypto API with AES-256-GCM
 */

export interface EncryptedData {
  data: string; // base64 encoded encrypted data
  iv: string; // base64 encoded initialization vector
  salt: string; // base64 encoded salt for key derivation
}

/**
 * Derive a crypto key from password using PBKDF2
 */
async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  // Import password as base key
  const baseKey = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  // Derive AES key from password
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt data with password using AES-256-GCM
 */
export async function encrypt(data: string, password: string): Promise<EncryptedData> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);

  // Generate random salt and IV
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Derive key from password
  const key = await deriveKey(password, salt);

  // Encrypt data
  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    dataBuffer
  );

  // Convert to base64 for storage
  return {
    data: arrayBufferToBase64(encryptedBuffer),
    iv: arrayBufferToBase64(iv),
    salt: arrayBufferToBase64(salt),
  };
}

/**
 * Decrypt data with password using AES-256-GCM
 */
export async function decrypt(encrypted: EncryptedData, password: string): Promise<string> {
  // Convert base64 back to ArrayBuffers
  const encryptedBuffer = base64ToArrayBuffer(encrypted.data);
  const iv = base64ToArrayBuffer(encrypted.iv);
  const salt = base64ToArrayBuffer(encrypted.salt);

  // Derive key from password
  const key = await deriveKey(password, new Uint8Array(salt));

  // Decrypt data
  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(iv),
    },
    key,
    encryptedBuffer
  );

  // Convert back to string
  const decoder = new TextDecoder();
  return decoder.decode(decryptedBuffer);
}

/**
 * Convert ArrayBuffer or Uint8Array to base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Generate a random password
 */
export function generatePassword(length = 32): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  const randomValues = crypto.getRandomValues(new Uint8Array(length));
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset[randomValues[i] % charset.length];
  }
  return password;
}
