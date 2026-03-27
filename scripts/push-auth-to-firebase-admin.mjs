#!/usr/bin/env node
import fs from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const ITERATIONS = 100_000;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const ENCRYPTION_ALGORITHM = 'AES-GCM-256';
const DEFAULT_DATABASE_URL = 'https://sync-cookie-default-rtdb.asia-southeast1.firebasedatabase.app';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SUPPORTED_DOMAINS_PATH = resolve(__dirname, '../src/lib/sync-core/supported-domains.json');

const args = process.argv.slice(2);

function getArg(name, fallback = undefined) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

function getArgs(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && index + 1 < args.length) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function showUsage() {
  const usage = `
Usage:
  node scripts/push-auth-to-firebase-admin.mjs \
    --service-account <path> | --database-secret <secret> \
    --uid <firebase-uid> \
    --sync-password <sync-password> \
    --file <path> [--file <path> ...] \
    [--database-url <databaseUrl>] [--dry-run]
`;
  console.error(usage);
}

function requireArg(name, value) {
  if (!value) {
    console.error(`Missing --${name}`);
    showUsage();
    process.exit(1);
  }
  return value;
}

function ensureValue(value, message) {
  if (!value) throw new Error(message);
}

function normalizeDomain(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/^\.+/, '');
}

function toDomainKey(domain) {
  return normalizeDomain(domain).replace(/\./g, ',');
}

function normalizeSameSite(value) {
  if (!value) return 'Unspecified';
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'no_restriction' || normalized === 'none') return 'None';
  if (normalized === 'strict') return 'Strict';
  if (normalized === 'lax') return 'Lax';
  return 'Unspecified';
}

function base64FromBytes(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function loadSupportedDomains() {
  return JSON.parse(await fs.readFile(SUPPORTED_DOMAINS_PATH, 'utf8'));
}

function findSupportedDomain(domain, supportedDomains) {
  const normalizedDomain = normalizeDomain(domain);
  const matches = supportedDomains
    .map((entry) => normalizeDomain(entry))
    .filter(Boolean)
    .filter((entry) => normalizedDomain === entry || normalizedDomain.endsWith(`.${entry}`))
    .sort((left, right) => right.length - left.length);
  return matches[0] ?? null;
}

function normalizeCookie(cookie, supportedDomains) {
  if (!cookie || typeof cookie.name !== 'string' || !cookie.name.trim()) {
    throw new Error('Invalid cookie: missing name');
  }

  const siteDomain = findSupportedDomain(cookie.domain, supportedDomains);
  if (!siteDomain) {
    throw new Error(`Unsupported cookie domain for ${cookie.name}: ${cookie.domain ?? 'unknown'}`);
  }

  const cookieDomain = normalizeDomain(cookie.domain);
  const path = typeof cookie.path === 'string' && cookie.path.trim() ? cookie.path : '/';

  return {
    siteDomain,
    cookie: {
      domain: cookieDomain,
      name: cookie.name,
      value: `${cookie.value ?? ''}`,
      path,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: normalizeSameSite(cookie.sameSite),
      expiresAt: typeof cookie.expirationDate === 'number'
        ? new Date(cookie.expirationDate * 1000).toISOString()
        : null,
      updatedAt: new Date().toISOString(),
      storeId: cookie.storeId ?? 'default',
    },
  };
}

async function encryptWithPassword(plaintext, password) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API is not available in this runtime.');
  }

  const encoder = new TextEncoder();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));

  return {
    algorithm: ENCRYPTION_ALGORITHM,
    iv: base64FromBytes(iv),
    salt: base64FromBytes(salt),
    ciphertext: base64FromBytes(new Uint8Array(ciphertext)),
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: ITERATIONS,
    },
  };
}

async function loadServiceAccount(path) {
  const raw = await fs.readFile(path, 'utf8');
  const json = JSON.parse(raw);
  ensureValue(json?.project_id, 'Invalid service account: missing project_id');
  ensureValue(json?.client_email, 'Invalid service account: missing client_email');
  ensureValue(json?.private_key, 'Invalid service account: missing private_key');
  return json;
}

function getOrCreateApp(serviceAccount, databaseURL) {
  const existing = getApps()[0];
  if (existing) return existing;

  return initializeApp({
    credential: cert(serviceAccount),
    databaseURL,
  });
}

async function patchWithDatabaseSecret({ databaseURL, databaseSecret, uid, records }) {
  const url = `${databaseURL}/sync/${encodeURIComponent(uid)}/sites.json?auth=${encodeURIComponent(databaseSecret)}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(records),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Realtime Database write failed (${response.status}): ${text || 'empty response'}`);
  }
}

async function main() {
  const serviceAccountPath = getArg('service-account');
  const databaseSecret = getArg('database-secret');
  const uid = requireArg('uid', getArg('uid'));
  const syncPassword = requireArg('sync-password', getArg('sync-password'));
  const filePaths = getArgs('file');
  const databaseURL = (getArg('database-url', DEFAULT_DATABASE_URL) ?? DEFAULT_DATABASE_URL).replace(/\/+$/, '');
  const isDryRun = args.includes('--dry-run');

  if (!isDryRun && !serviceAccountPath && !databaseSecret) {
    throw new Error('Provide either --service-account or --database-secret.');
  }

  if (filePaths.length === 0) {
    throw new Error('Provide at least one --file.');
  }

  const supportedDomains = await loadSupportedDomains();
  const inputs = await Promise.all(filePaths.map(async (filePath) => ({
    filePath,
    raw: JSON.parse(await fs.readFile(filePath, 'utf8')),
  })));

  const groupedCookies = new Map();
  for (const input of inputs) {
    const cookies = Array.isArray(input.raw.cookies) ? input.raw.cookies : [];
    for (const cookie of cookies) {
      const normalized = normalizeCookie(cookie, supportedDomains);
      const current = groupedCookies.get(normalized.siteDomain) ?? [];
      current.push(normalized.cookie);
      groupedCookies.set(normalized.siteDomain, current);
    }
  }

  const updatedAt = new Date().toISOString();
  const records = {};

  for (const [domain, cookies] of groupedCookies.entries()) {
    const encrypted = await encryptWithPassword(JSON.stringify({
      domain,
      cookies,
      sources: filePaths,
      pushedAt: updatedAt,
    }), syncPassword);

    records[toDomainKey(domain)] = {
      domain,
      payload: JSON.stringify(encrypted),
      updatedAt,
    };
  }

  if (Object.keys(records).length === 0) {
    throw new Error('No supported cookies found in input files.');
  }

  if (isDryRun) {
    console.log(JSON.stringify({
      ok: true,
      uid,
      recordCount: Object.keys(records).length,
      cookieCount: [...groupedCookies.values()].flat().length,
      databaseURL,
    }, null, 2));
    return;
  }

  if (databaseSecret) {
    await patchWithDatabaseSecret({ databaseURL, databaseSecret, uid, records });
  } else {
    const serviceAccount = await loadServiceAccount(serviceAccountPath);
    const app = getOrCreateApp(serviceAccount, databaseURL);
    const database = getDatabase(app);
    await database.ref(`sync/${uid}/sites`).update(records);
  }

  console.log(JSON.stringify({
    ok: true,
    uid,
    recordCount: Object.keys(records).length,
    cookieCount: [...groupedCookies.values()].flat().length,
    updatedAt,
    databaseURL,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
