/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

/**
 * Firebase Sync Client — all Firebase calls are routed through backend proxy.
 * This keeps Firebase API key/database URL out of extension bundles.
 */

const REQUEST_TIMEOUT_MS = 12_000;

function createSyncError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

function ensureProxyBaseUrl(proxyBaseUrl) {
  if (typeof proxyBaseUrl !== 'string' || !proxyBaseUrl.trim()) {
    throw createSyncError('config.missing_proxy_url', 'Firebase proxy URL is missing.');
  }

  return proxyBaseUrl.replace(/\/+$/, '');
}

async function proxyPost({ proxyBaseUrl, path, payload, fallbackCode, fallbackMessage }) {
  const baseUrl = ensureProxyBaseUrl(proxyBaseUrl);
  const url = `${baseUrl}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw createSyncError('proxy.timeout', 'Firebase proxy timeout. Please retry.');
    }

    throw createSyncError('proxy.network_error', 'Cannot connect to Firebase proxy. Check your network.');
  } finally {
    clearTimeout(timeout);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw createSyncError(
      data?.error ?? fallbackCode,
      data?.message ?? fallbackMessage,
      response.status,
    );
  }

  return data ?? {};
}

export async function firebaseRegister({ proxyBaseUrl, email, password }) {
  const data = await proxyPost({
    proxyBaseUrl,
    path: '/firebase/auth/register',
    payload: { email, password },
    fallbackCode: 'firebase.register_failed',
    fallbackMessage: 'Registration failed.',
  });

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.uid,
    email: data.email,
  };
}

export async function firebaseLogin({ proxyBaseUrl, email, password }) {
  const data = await proxyPost({
    proxyBaseUrl,
    path: '/firebase/auth/login',
    payload: { email, password },
    fallbackCode: 'firebase.login_failed',
    fallbackMessage: 'Login failed.',
  });

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.uid,
    email: data.email,
  };
}

export async function firebaseRefreshToken({ proxyBaseUrl, refreshToken }) {
  const data = await proxyPost({
    proxyBaseUrl,
    path: '/firebase/auth/refresh',
    payload: { refreshToken },
    fallbackCode: 'firebase.refresh_failed',
    fallbackMessage: 'Session expired. Please login again.',
  });

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.uid,
  };
}

export async function firebasePush({ proxyBaseUrl, idToken, payload }) {
  const data = await proxyPost({
    proxyBaseUrl,
    path: '/firebase/sync/push',
    payload: { idToken, payload },
    fallbackCode: 'firebase.push_failed',
    fallbackMessage: 'Failed to push cookie data.',
  });

  return {
    ok: data.ok === true,
    updatedAt: data.updatedAt ?? null,
    uid: data.uid ?? null,
  };
}

export async function firebasePull({ proxyBaseUrl, idToken }) {
  const data = await proxyPost({
    proxyBaseUrl,
    path: '/firebase/sync/pull',
    payload: { idToken },
    fallbackCode: 'firebase.pull_failed',
    fallbackMessage: 'Failed to pull cookie data.',
  });

  if (!data || !data.payload) {
    throw createSyncError('firebase.no_data', 'No synced data found. Push cookies first.', 404);
  }

  return {
    ok: data.ok === true,
    payload: data.payload,
    updatedAt: data.updatedAt ?? null,
    uid: data.uid ?? null,
  };
}
