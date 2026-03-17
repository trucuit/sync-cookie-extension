/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

/**
 * Firebase Sync Client — Firebase Auth + Realtime Database via REST API.
 * No SDK needed. All cookie data is encrypted client-side before sending.
 */

const FIREBASE_AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1/accounts';

function createSyncError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

// ─── Firebase Auth REST API ────────────────────────────────────────────────────

export async function firebaseRegister({ apiKey, email, password }) {
  const url = `${FIREBASE_AUTH_BASE}:signUp?key=${apiKey}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
  } catch {
    throw createSyncError('firebase.network_error', 'Cannot connect to Firebase. Check your network.');
  }

  const data = await response.json();

  if (!response.ok) {
    const fbError = data?.error?.message ?? 'Registration failed.';
    const friendlyMessage = firebaseErrorMessage(fbError);
    throw createSyncError('firebase.register_failed', friendlyMessage, response.status);
  }

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    email: data.email,
  };
}

export async function firebaseLogin({ apiKey, email, password }) {
  const url = `${FIREBASE_AUTH_BASE}:signInWithPassword?key=${apiKey}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
  } catch {
    throw createSyncError('firebase.network_error', 'Cannot connect to Firebase. Check your network.');
  }

  const data = await response.json();

  if (!response.ok) {
    const fbError = data?.error?.message ?? 'Login failed.';
    const friendlyMessage = firebaseErrorMessage(fbError);
    throw createSyncError('firebase.login_failed', friendlyMessage, response.status);
  }

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    email: data.email,
  };
}

export async function firebaseRefreshToken({ apiKey, refreshToken }) {
  const url = `https://securetoken.googleapis.com/v1/token?key=${apiKey}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });
  } catch {
    throw createSyncError('firebase.network_error', 'Cannot connect to Firebase.');
  }

  const data = await response.json();

  if (!response.ok) {
    throw createSyncError('firebase.refresh_failed', 'Session expired. Please login again.', response.status);
  }

  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    uid: data.user_id,
  };
}

// ─── Firebase Realtime Database REST API ───────────────────────────────────────

export async function firebasePush({ dbUrl, idToken, uid, payload }) {
  const url = `${dbUrl}/sync/${uid}.json?auth=${idToken}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload,
        updatedAt: new Date().toISOString(),
      }),
    });
  } catch {
    throw createSyncError('firebase.network_error', 'Cannot connect to Firebase Database.');
  }

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw createSyncError('firebase.push_failed', data?.error ?? 'Failed to push cookie data.', response.status);
  }

  return { ok: true, updatedAt: new Date().toISOString() };
}

export async function firebasePull({ dbUrl, idToken, uid }) {
  const url = `${dbUrl}/sync/${uid}.json?auth=${idToken}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw createSyncError('firebase.network_error', 'Cannot connect to Firebase Database.');
  }

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw createSyncError('firebase.pull_failed', data?.error ?? 'Failed to pull cookie data.', response.status);
  }

  const data = await response.json();

  if (!data || !data.payload) {
    throw createSyncError('firebase.no_data', 'No synced data found. Push cookies first.', 404);
  }

  return {
    ok: true,
    payload: data.payload,
    updatedAt: data.updatedAt ?? null,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function firebaseErrorMessage(errorCode) {
  const messages = {
    EMAIL_EXISTS: 'Email đã được đăng ký.',
    EMAIL_NOT_FOUND: 'Email hoặc password không đúng.',
    INVALID_PASSWORD: 'Email hoặc password không đúng.',
    INVALID_EMAIL: 'Email không hợp lệ.',
    WEAK_PASSWORD: 'Password phải ít nhất 6 ký tự.',
    USER_DISABLED: 'Tài khoản đã bị vô hiệu hoá.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Quá nhiều lần thử. Vui lòng thử lại sau.',
    INVALID_LOGIN_CREDENTIALS: 'Email hoặc password không đúng.',
  };

  // Firebase returns errors like "WEAK_PASSWORD : Password should be at least 6 characters"
  const baseCode = errorCode.split(':')[0].trim();
  return messages[baseCode] ?? errorCode;
}
