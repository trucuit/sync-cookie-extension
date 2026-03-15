import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { decrypt, encrypt, generatePassword } from '../src/lib/crypto';

beforeAll(() => {
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', {
      value: webcrypto,
      configurable: true,
    });
  }

  if (!globalThis.btoa) {
    Object.defineProperty(globalThis, 'btoa', {
      value: (binary: string) => Buffer.from(binary, 'binary').toString('base64'),
      configurable: true,
    });
  }

  if (!globalThis.atob) {
    Object.defineProperty(globalThis, 'atob', {
      value: (base64: string) => Buffer.from(base64, 'base64').toString('binary'),
      configurable: true,
    });
  }
});

describe('crypto utilities', () => {
  it('encrypts and decrypts payload correctly', async () => {
    const plainText = JSON.stringify({
      domain: 'example.com',
      cookies: [{ name: 'session', value: 'abc123' }],
      unicode: 'Xin chào 👋',
    });
    const password = 'strong-password-123';

    const encrypted = await encrypt(plainText, password);
    const decrypted = await decrypt(encrypted, password);

    expect(decrypted).toBe(plainText);
  });

  it('returns valid encrypted payload metadata', async () => {
    const encrypted = await encrypt('payload', 'password');

    expect(encrypted.data.length).toBeGreaterThan(0);
    expect(Buffer.from(encrypted.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(encrypted.salt, 'base64')).toHaveLength(16);
  });

  it('fails to decrypt with wrong password', async () => {
    const encrypted = await encrypt('sensitive-data', 'correct-password');

    await expect(decrypt(encrypted, 'wrong-password')).rejects.toThrow();
  });

  it('generates unique salt/iv between encrypt operations', async () => {
    const plainText = 'same input';
    const password = 'same-password';

    const first = await encrypt(plainText, password);
    const second = await encrypt(plainText, password);

    expect(first.iv).not.toBe(second.iv);
    expect(first.salt).not.toBe(second.salt);
    expect(first.data).not.toBe(second.data);
  });

  it('generates password with expected charset and length', () => {
    const password = generatePassword(64);

    expect(password).toHaveLength(64);
    expect(password).toMatch(/^[A-Za-z0-9!@#$%^&*]+$/);
  });

  it('uses default length and supports edge length 0', () => {
    expect(generatePassword()).toHaveLength(32);
    expect(generatePassword(0)).toBe('');
  });
});
