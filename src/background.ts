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
import {
  DEFAULT_DOMAIN_WHITELIST,
  findDomainMatch,
  groupCookiesByDomain,
  normalizeDomainWhitelist,
} from './lib/sync-core/sync-records';
import { DEFAULT_SYNC_PASSWORD } from './lib/sync-core/default-sync-password';

const STORAGE_KEYS = {
  simpleIdToken: 'pat.firebase.sync.id-token.v1',
  simpleRefreshToken: 'pat.firebase.sync.refresh-token.v1',
  simpleUid: 'pat.firebase.sync.uid.v1',
  simpleEmail: 'pat.firebase.sync.email.v1',
  simpleSyncState: 'pat.firebase.sync.state.v1',
  simpleTokenTimestamp: 'pat.firebase.sync.token-ts.v1',
} as const;


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

async function loadSyncSettings() {
  return { domainWhitelist: normalizeDomainWhitelist(DEFAULT_DOMAIN_WHITELIST) };
}

async function buildSyncPushRecords({ cookies, domainWhitelist, password }: {
  cookies: unknown[];
  domainWhitelist: string[];
  password: string;
}) {
  const groupedCookies = groupCookiesByDomain(cookies, domainWhitelist);
  const records = [];

  for (const [domain, siteCookies] of Object.entries(groupedCookies)) {
    const encrypted = await encryptUtf8WithPassword({
      plaintext: JSON.stringify({ domain, cookies: siteCookies, pushedAt: new Date().toISOString() }),
      password,
    });

    records.push({
      domain,
      payload: JSON.stringify(encrypted),
    });
  }

  return records;
}

async function decryptSiteRecord({ domain, payload, password }: {
  domain: string;
  payload: string;
  password: string;
}) {
  const encryptedPayload = JSON.parse(payload);
  const decrypted = await decryptUtf8WithPassword({
    encryptedPayload,
    password,
  });
  const parsed = JSON.parse(decrypted);

  if (!Array.isArray(parsed.cookies)) {
    throw createCodeError('firebase.invalid_payload', 'Dữ liệu sync không hợp lệ.');
  }

  const matchedDomain = findDomainMatch(parsed.domain ?? domain, [domain]);
  if (!matchedDomain) {
    throw createCodeError('firebase.invalid_payload', 'Domain record không hợp lệ.');
  }

  return {
    domain: matchedDomain,
    cookies: parsed.cookies,
  };
}

async function expandLegacyRecord({ legacyRecord, password, domainWhitelist }: {
  legacyRecord: { payload: string; updatedAt: string | null };
  password: string;
  domainWhitelist: string[];
}) {
  const encryptedPayload = JSON.parse(legacyRecord.payload);
  const decrypted = await decryptUtf8WithPassword({
    encryptedPayload,
    password,
  });
  const parsed = JSON.parse(decrypted);

  if (!Array.isArray(parsed.cookies)) {
    throw createCodeError('firebase.invalid_payload', 'Dữ liệu sync không hợp lệ.');
  }

  const groupedCookies = groupCookiesByDomain(parsed.cookies, domainWhitelist);
  return Object.entries(groupedCookies).map(([domain, cookies]) => ({
    domain,
    cookies,
  }));
}

const TOKEN_MAX_AGE_MS = 50 * 60 * 1000; // 50 minutes (Firebase tokens expire at 60 min)

async function getValidIdToken(): Promise<{ idToken: string; uid: string }> {
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
        const result = await firebaseRegister({
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
        const result = await firebaseLogin({
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
        const { idToken, uid } = await getValidIdToken();

        const syncPassword = `${request.password ?? ''}`.trim() || DEFAULT_SYNC_PASSWORD;

        const settings = await loadSyncSettings();
        const cookieStore = createChromeCookieStore({
          chromeApi: chrome,
          domainWhitelist: settings.domainWhitelist,
        });
        const cookies = await cookieStore.readCookies({ domainWhitelist: settings.domainWhitelist });
        const records = await buildSyncPushRecords({
          cookies,
          domainWhitelist: settings.domainWhitelist,
          password: syncPassword,
        });
        if (records.length === 0) {
          throw createCodeError('firebase.no_cookies', 'Không có cookies thuộc whitelist để sync.');
        }

        await firebasePush({
          idToken,
          uid,
          records,
        });

        await setLocalValue(STORAGE_KEYS.simpleSyncState, {
          lastPushedAt: new Date().toISOString(),
          cookieCount: cookies.length,
        });

        sendResponse({ ok: true, data: { cookieCount: cookies.length } });
        return;
      }

      case 'SIMPLE_SYNC_PULL': {
        const { idToken, uid } = await getValidIdToken();

        const syncPassword = `${request.password ?? ''}`.trim() || DEFAULT_SYNC_PASSWORD;

        const pullResult = await firebasePull({
          idToken,
          uid,
        });

        const settings = await loadSyncSettings();
        const cookieStore = createChromeCookieStore({
          chromeApi: chrome,
          domainWhitelist: settings.domainWhitelist,
        });
        const siteEntries = pullResult.records.length > 0
          ? await Promise.all(
            pullResult.records
              .filter((record: { domain?: string }) => Boolean(findDomainMatch(record.domain ?? '', settings.domainWhitelist)))
              .map((record: { domain: string; payload: string }) => decryptSiteRecord({
                domain: record.domain,
                payload: record.payload,
                password: syncPassword,
              }))
          )
          : pullResult.legacyRecord
            ? await expandLegacyRecord({
              legacyRecord: pullResult.legacyRecord,
              password: syncPassword,
              domainWhitelist: settings.domainWhitelist,
            })
            : [];

        if (siteEntries.length === 0) {
          throw createCodeError('firebase.no_data', 'Không có dữ liệu sync phù hợp với whitelist hiện tại.');
        }

        let removed = 0;
        let written = 0;
        let skipped = 0;
        let cookieCount = 0;

        for (const entry of siteEntries) {
          const writeResult = await cookieStore.replaceCookies(entry.cookies, { domainWhitelist: [entry.domain] });
          removed += writeResult.removed;
          written += writeResult.written;
          skipped += writeResult.skipped;
          cookieCount += entry.cookies.length;
        }

        await setLocalValue(STORAGE_KEYS.simpleSyncState, {
          lastPulledAt: new Date().toISOString(),
          cookieCount,
        });

        sendResponse({ ok: true, data: { removed, written, skipped, cookieCount } });
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
