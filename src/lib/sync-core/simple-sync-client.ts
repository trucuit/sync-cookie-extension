/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

/**
 * Firebase Sync Client — calls Firebase REST APIs directly.
 * No proxy needed. Firebase API key is public; security via Database Rules.
 */

import { FIREBASE_CONFIG } from './firebase-config';

const REQUEST_TIMEOUT_MS = 12_000;

const FIREBASE_ERROR_MESSAGES = {
  EMAIL_EXISTS: 'Email đã được đăng ký.',
  EMAIL_NOT_FOUND: 'Email hoặc password không đúng.',
  INVALID_PASSWORD: 'Email hoặc password không đúng.',
  INVALID_EMAIL: 'Email không hợp lệ.',
  WEAK_PASSWORD: 'Password phải ít nhất 6 ký tự.',
  USER_DISABLED: 'Tài khoản đã bị vô hiệu hoá.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Quá nhiều lần thử. Vui lòng thử lại sau.',
  INVALID_LOGIN_CREDENTIALS: 'Email hoặc password không đúng.',
};

function createSyncError(code, message, status?) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

function translateFirebaseError(errorCode) {
  if (typeof errorCode !== 'string' || !errorCode.trim()) {
    return 'Firebase request failed.';
  }
  const baseCode = errorCode.split(':')[0].trim();
  return FIREBASE_ERROR_MESSAGES[baseCode] ?? errorCode;
}

function normalizeSyncDomain(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/^\.+/, '');
}

function toSyncDomainKey(domain) {
  return normalizeSyncDomain(domain).replace(/\./g, ',');
}

async function fetchWithTimeout(url, init, fallbackCode, fallbackMessage) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw createSyncError(`${fallbackCode}_timeout`, `${fallbackMessage} (timeout)`);
    }
    throw createSyncError(`${fallbackCode}_network`, fallbackMessage);
  } finally {
    clearTimeout(timeout);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { response, data };
}

// ─── Auth ────────────────────────────────────────────────────────────────────

async function firebaseAuthRequest(action, payload) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${encodeURIComponent(FIREBASE_CONFIG.apiKey)}`;

  const { response, data } = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'firebase.auth',
    'Cannot connect to Firebase Auth.',
  );

  if (!response.ok) {
    const firebaseError = data?.error?.message ?? 'Firebase auth failed.';
    throw createSyncError('firebase.auth_failed', translateFirebaseError(firebaseError), response.status);
  }

  return data ?? {};
}

export async function firebaseRegister({ email, password }) {
  const data = await firebaseAuthRequest('signUp', {
    email,
    password,
    returnSecureToken: true,
  });

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    email: data.email,
  };
}

export async function firebaseLogin({ email, password }) {
  const data = await firebaseAuthRequest('signInWithPassword', {
    email,
    password,
    returnSecureToken: true,
  });

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    email: data.email,
  };
}

export async function firebaseRefreshToken({ refreshToken }) {
  const url = `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(FIREBASE_CONFIG.apiKey)}`;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const { response, data } = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    'firebase.refresh',
    'Cannot connect to Firebase token service.',
  );

  if (!response.ok) {
    throw createSyncError('firebase.refresh_failed', 'Session hết hạn. Vui lòng login lại.', response.status);
  }

  return {
    idToken: data?.id_token,
    refreshToken: data?.refresh_token,
    uid: data?.user_id,
  };
}

// ─── Sync ────────────────────────────────────────────────────────────────────

export async function firebasePush({ idToken, uid, records }) {
  const updatedAt = new Date().toISOString();
  const url = `${FIREBASE_CONFIG.dbUrl}/sync/${encodeURIComponent(uid)}/sites.json?auth=${encodeURIComponent(idToken)}`;

  const body = {};
  for (const record of records) {
    const domain = normalizeSyncDomain(record.domain);
    const domainKey = toSyncDomainKey(domain);
    body[domainKey] = {
      domain,
      payload: record.payload,
      updatedAt,
    };
  }

  const { response, data } = await fetchWithTimeout(
    url,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    'firebase.push',
    'Cannot connect to Firebase Database.',
  );

  if (!response.ok) {
    throw createSyncError('firebase.push_failed', data?.error ?? 'Failed to push cookie data.', response.status);
  }

  return {
    ok: true,
    updatedAt,
    uid,
    recordCount: records.length,
  };
}

export async function firebasePull({ idToken, uid }) {
  const url = `${FIREBASE_CONFIG.dbUrl}/sync/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(idToken)}`;

  const { response, data } = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
    },
    'firebase.pull',
    'Cannot connect to Firebase Database.',
  );

  if (!response.ok) {
    throw createSyncError('firebase.pull_failed', data?.error ?? 'Failed to pull cookie data.', response.status);
  }

  const records = data?.sites && typeof data.sites === 'object'
    ? Object.values(data.sites)
      .filter((record) => record && typeof record.domain === 'string' && typeof record.payload === 'string')
      .map((record) => ({
        domain: normalizeSyncDomain(record.domain),
        payload: record.payload,
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
      }))
    : [];

  const legacyRecord = data?.payload
    ? {
      payload: data.payload,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    }
    : null;

  if (records.length === 0 && !legacyRecord) {
    throw createSyncError('firebase.no_data', 'No synced data found. Push cookies first.', 404);
  }

  return {
    ok: true,
    records,
    legacyRecord,
    uid,
  };
}
