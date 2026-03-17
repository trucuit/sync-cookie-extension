import {
  AES_GCM_ALGORITHM,
  PBKDF2_HASH,
  PBKDF2_ITERATIONS,
  decryptUtf8WithPassword,
  encryptUtf8WithPassword,
} from './sync-core/gist-sync-crypto';

export interface EncryptedData {
  data: string;
  iv: string;
  salt: string;
}

export async function encrypt(data: string, password: string): Promise<EncryptedData> {
  const encrypted = await encryptUtf8WithPassword({
    plaintext: data,
    password,
  });

  return {
    data: encrypted.ciphertext,
    iv: encrypted.iv,
    salt: encrypted.salt,
  };
}

export async function decrypt(encrypted: EncryptedData, password: string): Promise<string> {
  return decryptUtf8WithPassword({
    password,
    encryptedPayload: {
      algorithm: AES_GCM_ALGORITHM,
      iv: encrypted.iv,
      salt: encrypted.salt,
      ciphertext: encrypted.data,
      kdf: {
        name: 'PBKDF2',
        hash: PBKDF2_HASH,
        iterations: PBKDF2_ITERATIONS,
      },
    },
  });
}

export function generatePassword(length = 32): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  const randomValues = crypto.getRandomValues(new Uint8Array(length));
  let password = '';

  for (let index = 0; index < length; index += 1) {
    password += charset[randomValues[index] % charset.length];
  }

  return password;
}

