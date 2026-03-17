/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import { createChromeCookieStore } from './lib/sync-core/cookie-store';
import {
  firebaseRegister,
  firebaseLogin,
  firebaseRefreshToken,
  firebasePush,
  firebasePull,
} from './lib/sync-core/simple-sync-client';
import { encryptUtf8WithPassword, decryptUtf8WithPassword } from './lib/sync-core/sync-crypto';

const STORAGE_KEYS = {
  settings: 'pat.sync.settings.v1',
  simpleIdToken: 'pat.firebase.sync.id-token.v1',
  simpleRefreshToken: 'pat.firebase.sync.refresh-token.v1',
  simpleUid: 'pat.firebase.sync.uid.v1',
  simpleEmail: 'pat.firebase.sync.email.v1',
  simpleSyncState: 'pat.firebase.sync.state.v1',
  simpleTokenTimestamp: 'pat.firebase.sync.token-ts.v1',
} as const;

const ENV_CONFIG = {
  firebaseProxyUrl: import.meta.env.VITE_FIREBASE_PROXY_URL ?? '',
};

function requireFirebaseProxyUrl() {
  const proxyUrl = `${ENV_CONFIG.firebaseProxyUrl ?? ''}`.trim();
  if (!proxyUrl) {
    throw createCodeError(
      'config.missing_proxy_url',
      'Thiếu VITE_FIREBASE_PROXY_URL. Hãy cấu hình Firebase proxy trước khi dùng sync.',
    );
  }

  return proxyUrl;
}

function createCodeError(code: string, message: string, status?: number) {
  const error = new Error(message) as Error & { code?: string; status?: number };
  error.code = code;
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    const parsed = error as Error & { code?: string; status?: number; details?: unknown };
    return {
      code: parsed.code ?? 'unknown_error',
      status: parsed.status,
      message: parsed.message,
      details: parsed.details,
    };
  }

  return {
    code: 'unknown_error',
    message: 'Unknown error',
    details: error,
  };
}

async function getLocalValue<T>(key: string, fallback: T): Promise<T> {
  const result = await chrome.storage.local.get(key);
  return (result[key] as T | undefined) ?? fallback;
}

async function setLocalValue(key: string, value: unknown) {
  await chrome.storage.local.set({ [key]: value });
}

async function removeLocalValue(key: string) {
  await chrome.storage.local.remove(key);
}

async function getSessionValue<T>(key: string, fallback: T): Promise<T> {
  const result = await chrome.storage.session.get(key);
  return (result[key] as T | undefined) ?? fallback;
}

async function setSessionValue(key: string, value: unknown) {
  await chrome.storage.session.set({ [key]: value });
}

async function removeSessionValue(key: string) {
  await chrome.storage.session.remove(key);
}

function normalizeSyncSettings(input: Record<string, unknown>) {
  return {
    domainWhitelist: Array.isArray(input?.domainWhitelist)
      ? input.domainWhitelist.filter((d: unknown) => typeof d === 'string' && d.trim()).map((d: string) => d.trim().toLowerCase())
      : [],
  };
}

async function loadSyncSettings() {
  const raw = await getLocalValue<Record<string, unknown> | null>(STORAGE_KEYS.settings, null);
  return normalizeSyncSettings(raw ?? {});
}

const TOKEN_MAX_AGE_MS = 50 * 60 * 1000; // 50 minutes (Firebase tokens expire at 60 min)

async function getValidIdToken(proxyBaseUrl: string): Promise<{ idToken: string; uid: string }> {
  const idToken = await getSessionValue<string | null>(STORAGE_KEYS.simpleIdToken, null);
  const uid = await getSessionValue<string | null>(STORAGE_KEYS.simpleUid, null);

  if (!idToken || !uid) {
    throw createCodeError('firebase.not_logged_in', 'Đăng nhập trước khi thực hiện thao tác.');
  }

  const tokenTimestamp = await getSessionValue<number | null>(STORAGE_KEYS.simpleTokenTimestamp, null);
  const age = tokenTimestamp ? Date.now() - tokenTimestamp : Infinity;

  if (age < TOKEN_MAX_AGE_MS) {
    return { idToken, uid };
  }

  // Token is near expiry — auto-refresh
  const refreshTk = await getSessionValue<string | null>(STORAGE_KEYS.simpleRefreshToken, null);
  if (!refreshTk) {
    throw createCodeError('firebase.session_expired', 'Session hết hạn. Vui lòng login lại.');
  }

  const result = await firebaseRefreshToken({
    proxyBaseUrl,
    refreshToken: refreshTk,
  });

  await setSessionValue(STORAGE_KEYS.simpleIdToken, result.idToken);
  await setSessionValue(STORAGE_KEYS.simpleRefreshToken, result.refreshToken);
  if (result.uid) {
    await setSessionValue(STORAGE_KEYS.simpleUid, result.uid);
  }
  await setSessionValue(STORAGE_KEYS.simpleTokenTimestamp, Date.now());

  return { idToken: result.idToken, uid: result.uid ?? uid };
}


// ─── Listeners ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('Sync Cookie Extension installed');
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    switch (request?.type) {
      // ─── Firebase Sync handlers ─────────────────────────────────────

      case 'SIMPLE_AUTH_REGISTER': {
        const proxyBaseUrl = requireFirebaseProxyUrl();
        const result = await firebaseRegister({
          proxyBaseUrl,
          email: request.email ?? '',
          password: request.password ?? '',
        });
        await setSessionValue(STORAGE_KEYS.simpleIdToken, result.idToken);
        await setSessionValue(STORAGE_KEYS.simpleRefreshToken, result.refreshToken);
        await setSessionValue(STORAGE_KEYS.simpleUid, result.uid);
        await setSessionValue(STORAGE_KEYS.simpleEmail, result.email);
        await setSessionValue(STORAGE_KEYS.simpleTokenTimestamp, Date.now());
        sendResponse({ ok: true, data: { email: result.email, uid: result.uid } });
        return;
      }

      case 'SIMPLE_AUTH_LOGIN': {
        const proxyBaseUrl = requireFirebaseProxyUrl();
        const result = await firebaseLogin({
          proxyBaseUrl,
          email: request.email ?? '',
          password: request.password ?? '',
        });
        await setSessionValue(STORAGE_KEYS.simpleIdToken, result.idToken);
        await setSessionValue(STORAGE_KEYS.simpleRefreshToken, result.refreshToken);
        await setSessionValue(STORAGE_KEYS.simpleUid, result.uid);
        await setSessionValue(STORAGE_KEYS.simpleEmail, result.email);
        await setSessionValue(STORAGE_KEYS.simpleTokenTimestamp, Date.now());
        sendResponse({ ok: true, data: { email: result.email, uid: result.uid } });
        return;
      }

      case 'SIMPLE_AUTH_LOGOUT': {
        await removeSessionValue(STORAGE_KEYS.simpleIdToken);
        await removeSessionValue(STORAGE_KEYS.simpleRefreshToken);
        await removeSessionValue(STORAGE_KEYS.simpleUid);
        await removeSessionValue(STORAGE_KEYS.simpleEmail);
        await removeSessionValue(STORAGE_KEYS.simpleTokenTimestamp);
        await removeLocalValue(STORAGE_KEYS.simpleSyncState);
        sendResponse({ ok: true, data: { loggedOut: true } });
        return;
      }

      case 'SIMPLE_SYNC_PUSH': {
        const proxyBaseUrl = requireFirebaseProxyUrl();
        const { idToken } = await getValidIdToken(proxyBaseUrl);

        const syncPassword = request.password ?? '';
        if (!syncPassword.trim()) {
          throw createCodeError('firebase.password_required', 'Nhập sync password để mã hoá cookies.');
        }

        const settings = await loadSyncSettings();
        const cookieStore = createChromeCookieStore({
          chromeApi: chrome,
          domainWhitelist: settings.domainWhitelist,
        });
        const cookies = await cookieStore.readCookies({ domainWhitelist: settings.domainWhitelist });

        const encrypted = await encryptUtf8WithPassword({
          plaintext: JSON.stringify({ cookies, pushedAt: new Date().toISOString() }),
          password: syncPassword,
        });

        await firebasePush({
          proxyBaseUrl,
          idToken,
          payload: JSON.stringify(encrypted),
        });

        await setLocalValue(STORAGE_KEYS.simpleSyncState, {
          lastPushedAt: new Date().toISOString(),
          cookieCount: cookies.length,
        });

        sendResponse({ ok: true, data: { cookieCount: cookies.length } });
        return;
      }

      case 'SIMPLE_SYNC_PULL': {
        const proxyBaseUrl = requireFirebaseProxyUrl();
        const { idToken } = await getValidIdToken(proxyBaseUrl);

        const syncPassword = request.password ?? '';
        if (!syncPassword.trim()) {
          throw createCodeError('firebase.password_required', 'Nhập sync password để giải mã cookies.');
        }

        const pullResult = await firebasePull({
          proxyBaseUrl,
          idToken,
        });
        const encryptedPayload = JSON.parse(pullResult.payload);

        const decrypted = await decryptUtf8WithPassword({
          encryptedPayload,
          password: syncPassword,
        });

        const parsed = JSON.parse(decrypted);
        if (!Array.isArray(parsed.cookies)) {
          throw createCodeError('firebase.invalid_payload', 'Dữ liệu sync không hợp lệ.');
        }

        const settings = await loadSyncSettings();
        const cookieStore = createChromeCookieStore({
          chromeApi: chrome,
          domainWhitelist: settings.domainWhitelist,
        });
        const writeResult = await cookieStore.replaceCookies(parsed.cookies, { domainWhitelist: settings.domainWhitelist });

        await setLocalValue(STORAGE_KEYS.simpleSyncState, {
          lastPulledAt: new Date().toISOString(),
          cookieCount: parsed.cookies.length,
        });

        sendResponse({ ok: true, data: { ...writeResult, cookieCount: parsed.cookies.length, pulledAt: pullResult.updatedAt } });
        return;
      }

      case 'SIMPLE_SYNC_STATUS': {
        const [simpleIdToken, simpleEmail, simpleSyncState] = await Promise.all([
          getSessionValue(STORAGE_KEYS.simpleIdToken, null),
          getSessionValue(STORAGE_KEYS.simpleEmail, null),
          getLocalValue(STORAGE_KEYS.simpleSyncState, null),
        ]);

        sendResponse({
          ok: true,
          data: {
            loggedIn: Boolean(simpleIdToken),
            email: simpleEmail,
            syncState: simpleSyncState,
          },
        });
        return;
      }

      default:
        throw createCodeError('request.unsupported', `Unsupported request type: ${request?.type ?? 'unknown'}`);
    }
  })()
    .catch((error) => {
      sendResponse({
        ok: false,
        error: serializeError(error),
      });
    });

  return true;
});
