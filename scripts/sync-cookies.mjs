#!/usr/bin/env node

/**
 * Auto-sync cookies to Firebase Realtime Database.
 *
 * Tự động tìm file cookie mới nhất trong ~/Downloads theo pattern:
 *   chatgpt.com*.json, claude.ai*.json, gemini.google.com*.json
 *
 * Usage:
 *   node scripts/sync-cookies.mjs --email <email> --password <pw> --sync-password <sp>
 *   node scripts/sync-cookies.mjs --email <email> --password <pw>   # uses default sync password
 *   node scripts/sync-cookies.mjs --email <email> --password <pw> --register  # register first time
 *   node scripts/sync-cookies.mjs --email <email> --password <pw> --dir ~/Desktop  # custom dir
 *   node scripts/sync-cookies.mjs --email <email> --password <pw> --dry-run
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────────────

const FIREBASE_API_KEY = 'AIzaSyBI_As80APDng7E0ggxz8aRb9MVI0D1Eec';
const FIREBASE_DB_URL = 'https://sync-cookie-default-rtdb.asia-southeast1.firebasedatabase.app';
const DEFAULT_SYNC_PASSWORD = 'SyncCookie#20260327!';

const ITERATIONS = 100_000;
const IV_BYTES = 12;
const SALT_BYTES = 16;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SUPPORTED_DOMAINS_PATH = resolve(__dirname, '../src/lib/sync-core/supported-domains.json');

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name, fallback = undefined) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

function requireArg(name, value) {
  if (!value) {
    console.error(`❌ Missing --${name}`);
    console.error(`\nUsage: node scripts/sync-cookies.mjs --email <email> --password <pw> [--sync-password <sp>] [--dir <path>] [--register] [--dry-run]`);
    process.exit(1);
  }
  return value;
}

const email = requireArg('email', getArg('email'));
const password = requireArg('password', getArg('password'));
const syncPassword = getArg('sync-password', DEFAULT_SYNC_PASSWORD);
const searchDir = getArg('dir', path.join(os.homedir(), 'Downloads'));
const shouldRegister = args.includes('--register');
const isDryRun = args.includes('--dry-run');

// ─── Domain helpers ──────────────────────────────────────────────────────────

function normalizeDomain(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/^\.+/, '');
}

function toDomainKey(domain) {
  return normalizeDomain(domain).replace(/\./g, ',');
}

function normalizeSameSite(value) {
  if (!value) return 'Unspecified';
  const n = String(value).trim().toLowerCase();
  if (n === 'no_restriction' || n === 'none') return 'None';
  if (n === 'strict') return 'Strict';
  if (n === 'lax') return 'Lax';
  return 'Unspecified';
}

// ─── Find latest cookie files ────────────────────────────────────────────────

async function loadSupportedDomains() {
  return JSON.parse(await fs.readFile(SUPPORTED_DOMAINS_PATH, 'utf8'));
}

function buildFilePatterns(domains) {
  // Match: chatgpt.com*.json, claude.ai*.json, etc.
  return domains.map((d) => normalizeDomain(d)).filter(Boolean);
}

async function findLatestCookieFiles(dir, domainPatterns) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error(`Cannot read directory: ${dir}`);
  }

  // For each domain pattern, find the newest matching .json file
  const results = new Map();

  const jsonFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));

  // Get stats for all json files
  const fileInfos = await Promise.all(
    jsonFiles.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      const stat = await fs.stat(fullPath);
      return { name: entry.name, path: fullPath, mtime: stat.mtimeMs };
    }),
  );

  for (const domain of domainPatterns) {
    // Match files starting with domain name (e.g. "chatgpt.com_cookies.json", "claude.ai (1).json")
    const matching = fileInfos
      .filter((f) => f.name.toLowerCase().startsWith(domain))
      .sort((a, b) => b.mtime - a.mtime);

    if (matching.length > 0) {
      results.set(domain, matching[0]);
    }
  }

  return results;
}

// ─── Cookie normalization ────────────────────────────────────────────────────

function findSupportedDomain(domain, supportedDomains) {
  const nd = normalizeDomain(domain);
  const matches = supportedDomains
    .map((e) => normalizeDomain(e))
    .filter(Boolean)
    .filter((e) => nd === e || nd.endsWith(`.${e}`))
    .sort((a, b) => b.length - a.length);
  return matches[0] ?? null;
}

function normalizeCookie(cookie, supportedDomains) {
  if (!cookie || typeof cookie.name !== 'string' || !cookie.name.trim()) return null;

  const siteDomain = findSupportedDomain(cookie.domain, supportedDomains);
  if (!siteDomain) return null;

  return {
    siteDomain,
    cookie: {
      domain: normalizeDomain(cookie.domain),
      name: cookie.name,
      value: `${cookie.value ?? ''}`,
      path: typeof cookie.path === 'string' && cookie.path.trim() ? cookie.path : '/',
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

// ─── Encryption ──────────────────────────────────────────────────────────────

function base64FromBytes(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function encryptWithPassword(plaintext, pw) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto API not available.');

  const encoder = new TextEncoder();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await subtle.importKey('raw', encoder.encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));

  return {
    algorithm: 'AES-GCM-256',
    iv: base64FromBytes(iv),
    salt: base64FromBytes(salt),
    ciphertext: base64FromBytes(new Uint8Array(ciphertext)),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS },
  };
}

// ─── Firebase REST API ───────────────────────────────────────────────────────

async function firebaseAuth(action, payload) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `Firebase auth failed (${res.status})`);
  return data;
}

async function firebaseLogin(em, pw) {
  const d = await firebaseAuth('signInWithPassword', { email: em, password: pw, returnSecureToken: true });
  return { idToken: d.idToken, uid: d.localId };
}

async function firebaseRegister(em, pw) {
  const d = await firebaseAuth('signUp', { email: em, password: pw, returnSecureToken: true });
  return { idToken: d.idToken, uid: d.localId };
}

async function firebasePush(idToken, uid, records) {
  const url = `${FIREBASE_DB_URL}/sync/${encodeURIComponent(uid)}/sites.json?auth=${encodeURIComponent(idToken)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(records),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firebase push failed (${res.status}): ${text}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const supportedDomains = await loadSupportedDomains();
  const domainPatterns = buildFilePatterns(supportedDomains);

  console.log(`🔍 Scanning ${searchDir} for cookie files...`);
  const found = await findLatestCookieFiles(searchDir, domainPatterns);

  if (found.size === 0) {
    console.error(`❌ No cookie files found in ${searchDir}`);
    console.error(`   Expected files like: chatgpt.com*.json, claude.ai*.json, gemini.google.com*.json`);
    process.exit(1);
  }

  for (const [domain, info] of found) {
    const age = Math.round((Date.now() - info.mtime) / 1000 / 60);
    console.log(`  ✅ ${domain} → ${info.name} (${age}m ago)`);
  }

  // Read & group cookies
  const groupedCookies = new Map();
  for (const [, info] of found) {
    const raw = JSON.parse(await fs.readFile(info.path, 'utf8'));
    const cookies = Array.isArray(raw) ? raw : Array.isArray(raw.cookies) ? raw.cookies : [];
    for (const cookie of cookies) {
      const normalized = normalizeCookie(cookie, supportedDomains);
      if (!normalized) continue;
      const current = groupedCookies.get(normalized.siteDomain) ?? [];
      current.push(normalized.cookie);
      groupedCookies.set(normalized.siteDomain, current);
    }
  }

  const totalCookies = [...groupedCookies.values()].flat().length;
  console.log(`\n🍪 ${totalCookies} cookies across ${groupedCookies.size} domain(s)`);

  if (totalCookies === 0) {
    console.error('❌ No valid cookies found.');
    process.exit(1);
  }

  // Encrypt
  const updatedAt = new Date().toISOString();
  const records = {};

  for (const [domain, cookies] of groupedCookies.entries()) {
    const encrypted = await encryptWithPassword(JSON.stringify({
      domain,
      cookies,
      pushedAt: updatedAt,
    }), syncPassword);

    records[toDomainKey(domain)] = {
      domain,
      payload: JSON.stringify(encrypted),
      updatedAt,
    };
  }

  if (isDryRun) {
    console.log('\n🏁 Dry run — would push:');
    console.log(JSON.stringify({ recordCount: Object.keys(records).length, totalCookies, updatedAt }, null, 2));
    return;
  }

  // Auth
  console.log('\n🔐 Logging in...');
  let auth;
  try {
    auth = await firebaseLogin(email, password);
  } catch (err) {
    if (!shouldRegister) throw err;
    console.log('   Registering new account...');
    auth = await firebaseRegister(email, password);
  }

  // Push
  console.log('🚀 Pushing to Firebase...');
  await firebasePush(auth.idToken, auth.uid, records);

  console.log(`\n✅ Done! ${Object.keys(records).length} domain(s), ${totalCookies} cookies synced.`);
  console.log(`   uid: ${auth.uid}`);
  console.log(`   updatedAt: ${updatedAt}`);
}

main().catch((error) => {
  console.error(`\n❌ ${error?.message || error}`);
  process.exit(1);
});
