/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { nowIso } from './fixtures';
import { createEncryptedManifest, decryptManifestPayload } from './gist-sync-crypto';

const COOKIE_SYNC_SCHEMA = 'pat-cookie-sync-v1';
const DEFAULT_CONFLICT_POLICY = 'LWW';
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_INITIAL_BACKOFF_MS = 200;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_JITTER_FACTOR = 0.1;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createCodeError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}

function normalizeDomain(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return `${value}`.trim().toLowerCase().replace(/^\.+/, '');
}

function normalizeDomainWhitelist(domainWhitelist = []) {
  if (!Array.isArray(domainWhitelist)) {
    return [];
  }

  const normalized = domainWhitelist
    .map((value) => normalizeDomain(value))
    .filter(Boolean);

  return [...new Set(normalized)].sort();
}

function isPromiseLike(value) {
  return Boolean(value) && typeof value.then === 'function';
}

function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoOrNull(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Date.parse(`${value}`);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function normalizeSameSite(value) {
  if (!value) {
    return 'Unspecified';
  }

  const normalized = `${value}`.trim().toLowerCase();
  if (normalized === 'no_restriction' || normalized === 'none') {
    return 'None';
  }

  if (normalized === 'strict') {
    return 'Strict';
  }

  if (normalized === 'lax') {
    return 'Lax';
  }

  return 'Unspecified';
}

function toChromeSameSite(value) {
  const normalized = normalizeSameSite(value);
  if (normalized === 'None') {
    return 'no_restriction';
  }

  if (normalized === 'Strict') {
    return 'strict';
  }

  if (normalized === 'Lax') {
    return 'lax';
  }

  return 'unspecified';
}

function maybeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cookieIdentity(cookie) {
  return [normalizeDomain(cookie.domain), cookie.path ?? '/', cookie.name ?? '', cookie.storeId ?? 'default'].join('|');
}

function cookieFingerprint(cookie) {
  return JSON.stringify({
    domain: normalizeDomain(cookie.domain),
    path: cookie.path ?? '/',
    name: cookie.name ?? '',
    value: cookie.value ?? '',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: normalizeSameSite(cookie.sameSite),
    expiresAt: cookie.expiresAt ?? null,
    storeId: cookie.storeId ?? 'default',
  });
}

function isConflict(localCookie, remoteCookie) {
  return cookieFingerprint(localCookie) !== cookieFingerprint(remoteCookie);
}

function compareCookieFreshness(localCookie, remoteCookie) {
  const localUpdatedAt = parseIsoTimestamp(localCookie.updatedAt) ?? parseIsoTimestamp(localCookie.expiresAt) ?? 0;
  const remoteUpdatedAt = parseIsoTimestamp(remoteCookie.updatedAt) ?? parseIsoTimestamp(remoteCookie.expiresAt) ?? 0;

  if (localUpdatedAt !== remoteUpdatedAt) {
    return localUpdatedAt - remoteUpdatedAt;
  }

  return cookieFingerprint(localCookie).localeCompare(cookieFingerprint(remoteCookie));
}

function normalizeConflictPolicy(conflictPolicy = DEFAULT_CONFLICT_POLICY) {
  const normalized = `${conflictPolicy}`.trim();
  const supported = ['LWW', 'keep_local', 'keep_remote', 'manual_merge'];
  if (!supported.includes(normalized)) {
    throw createCodeError(
      'sync.invalid_conflict_policy',
      `conflictPolicy must be one of ${supported.join(', ')}`
    );
  }

  return normalized;
}

function deriveCookieUrl(cookie) {
  if (typeof cookie.url === 'string' && cookie.url.trim()) {
    return cookie.url;
  }

  const hostname = normalizeDomain(cookie.domain);
  if (!hostname) {
    throw createCodeError('cookie.invalid_domain', 'Cookie domain is required to derive URL.');
  }

  const protocol = cookie.secure ? 'https' : 'http';
  const path = cookie.path ?? '/';
  return `${protocol}://${hostname}${path.startsWith('/') ? path : `/${path}`}`;
}

function normalizeCookieRecord(cookie = {}, now = nowIso()) {
  if (typeof cookie.name !== 'string' || !cookie.name.trim()) {
    throw createCodeError('cookie.invalid_name', 'Cookie name is required.');
  }

  const domain = normalizeDomain(cookie.domain);
  if (!domain) {
    throw createCodeError('cookie.invalid_domain', 'Cookie domain is required.');
  }

  const path = typeof cookie.path === 'string' && cookie.path.trim() ? cookie.path : '/';
  const expiresAt =
    typeof cookie.expiresAt === 'string'
      ? toIsoOrNull(cookie.expiresAt)
      : maybeNumber(cookie.expirationDate) !== null
        ? toIsoOrNull(maybeNumber(cookie.expirationDate) * 1000)
        : null;

  return {
    domain,
    name: cookie.name,
    value: `${cookie.value ?? ''}`,
    path,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: normalizeSameSite(cookie.sameSite),
    expiresAt,
    updatedAt: toIsoOrNull(cookie.updatedAt) ?? now,
    storeId: cookie.storeId ?? 'default',
  };
}

function normalizeAndFilterCookies(cookies = [], domainWhitelist = []) {
  return cookies
    .map((cookie) => normalizeCookieRecord(cookie))
    .filter((cookie) => matchesDomainWhitelist(cookie.domain, domainWhitelist));
}

function toChromeSetDetails(cookie) {
  const payload = {
    url: deriveCookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: toChromeSameSite(cookie.sameSite),
    storeId: cookie.storeId,
    domain: cookie.domain,
  };

  const expiresMs = parseIsoTimestamp(cookie.expiresAt);
  if (expiresMs !== null) {
    payload.expirationDate = expiresMs / 1000;
  }

  return payload;
}

function toChromeRemoveDetails(cookie) {
  return {
    url: deriveCookieUrl(cookie),
    name: cookie.name,
    storeId: cookie.storeId,
  };
}

function isRateLimitedError(error) {
  if (!error) {
    return false;
  }

  if (error.code === 'rate.limited' || error.status === 429) {
    return true;
  }

  return error.status === 403 && /rate limit/i.test(`${error.message ?? ''}`);
}

function isRetryableError(error) {
  if (!error) {
    return false;
  }

  if (isRateLimitedError(error)) {
    return true;
  }

  if (error.code === 'request.network' || error.code === 'request.timeout') {
    return true;
  }

  const status = Number(error.status);
  return Number.isFinite(status) && status >= 500;
}

function parseRetryAfterMs(error) {
  if (!error) {
    return null;
  }

  const retryAfterSeconds = maybeNumber(error.retryAfterSeconds);
  if (retryAfterSeconds !== null && retryAfterSeconds >= 0) {
    return Math.round(retryAfterSeconds * 1000);
  }

  const retryAfter = error.retryAfter ?? null;
  if (retryAfter === null || retryAfter === undefined) {
    return null;
  }

  const numeric = maybeNumber(retryAfter);
  if (numeric !== null && numeric >= 0) {
    return Math.round(numeric * 1000);
  }

  const parsedDate = Date.parse(`${retryAfter}`);
  if (!Number.isFinite(parsedDate)) {
    return null;
  }

  return Math.max(0, parsedDate - Date.now());
}

function computeBackoffMs({
  attempt,
  error,
  initialBackoffMs,
  maxBackoffMs,
  jitterFactor,
  randomFn,
}) {
  const retryAfterMs = parseRetryAfterMs(error);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  const baseDelay = Math.min(maxBackoffMs, initialBackoffMs * 2 ** Math.max(attempt - 1, 0));
  const jitterWindow = baseDelay * Math.max(0, jitterFactor);
  if (jitterWindow === 0) {
    return Math.round(baseDelay);
  }

  const jitter = (randomFn() * 2 - 1) * jitterWindow;
  return Math.max(0, Math.round(baseDelay + jitter));
}

async function executeWithRetry(operation, options = {}) {
  const maxAttempts = Number(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw createCodeError('sync.invalid_retry_config', 'maxAttempts must be a positive integer.');
  }

  const initialBackoffMs = Number(options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS);
  const maxBackoffMs = Number(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
  const jitterFactor = Number(options.jitterFactor ?? DEFAULT_JITTER_FACTOR);
  const sleepFn = options.sleepFn ?? sleep;
  const randomFn = options.randomFn ?? Math.random;

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      const result = await operation({ attempt, maxAttempts });
      return {
        attempt,
        result,
      };
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableError(error)) {
        error.attempts = attempt;
        throw error;
      }

      const delayMs = computeBackoffMs({
        attempt,
        error,
        initialBackoffMs,
        maxBackoffMs,
        jitterFactor,
        randomFn,
      });

      if (typeof options.onRetry === 'function') {
        await options.onRetry({
          attempt,
          maxAttempts,
          delayMs,
          error,
        });
      }

      await sleepFn(delayMs);
    }
  }

  throw createCodeError('sync.retry_exhausted', 'Retry attempts exhausted.');
}

async function callChromeCookiesApi(chromeApi, methodName, ...args) {
  const cookiesApi = chromeApi?.cookies;
  const method = cookiesApi?.[methodName];
  if (typeof method !== 'function') {
    throw createCodeError('cookie.api_missing', `chrome.cookies.${methodName} is not available.`);
  }

  if (method.length > args.length) {
    return new Promise((resolve, reject) => {
      method.call(cookiesApi, ...args, (result) => {
        const runtimeError = chromeApi?.runtime?.lastError;
        if (runtimeError) {
          reject(createCodeError('cookie.runtime_error', runtimeError.message ?? 'Unknown chrome.runtime.lastError'));
          return;
        }
        resolve(result);
      });
    });
  }

  const output = method.call(cookiesApi, ...args);
  if (isPromiseLike(output)) {
    return output;
  }
  return output;
}

export function matchesDomainWhitelist(domain, domainWhitelist = []) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedWhitelist = normalizeDomainWhitelist(domainWhitelist);

  if (!normalizedDomain) {
    return false;
  }

  if (normalizedWhitelist.length === 0) {
    return true;
  }

  return normalizedWhitelist.some(
    (entry) => normalizedDomain === entry || normalizedDomain.endsWith(`.${entry}`)
  );
}

export function mergeCookieCollections({
  localCookies = [],
  remoteCookies = [],
  conflictPolicy = DEFAULT_CONFLICT_POLICY,
} = {}) {
  const resolvedPolicy = normalizeConflictPolicy(conflictPolicy);

  const localMap = new Map();
  const remoteMap = new Map();

  for (const cookie of localCookies) {
    const normalized = normalizeCookieRecord(cookie);
    localMap.set(cookieIdentity(normalized), normalized);
  }

  for (const cookie of remoteCookies) {
    const normalized = normalizeCookieRecord(cookie);
    remoteMap.set(cookieIdentity(normalized), normalized);
  }

  const keys = [...new Set([...localMap.keys(), ...remoteMap.keys()])].sort();
  const mergedCookies = [];
  const conflicts = [];
  const unresolvedConflicts = [];

  for (const key of keys) {
    const localCookie = localMap.get(key);
    const remoteCookie = remoteMap.get(key);

    if (!localCookie) {
      mergedCookies.push(remoteCookie);
      continue;
    }

    if (!remoteCookie) {
      mergedCookies.push(localCookie);
      continue;
    }

    const hasConflict = isConflict(localCookie, remoteCookie);
    if (!hasConflict) {
      mergedCookies.push(compareCookieFreshness(localCookie, remoteCookie) >= 0 ? localCookie : remoteCookie);
      continue;
    }

    let winner = null;
    let resolution = resolvedPolicy;

    if (resolvedPolicy === 'keep_local') {
      winner = localCookie;
    } else if (resolvedPolicy === 'keep_remote') {
      winner = remoteCookie;
    } else if (resolvedPolicy === 'manual_merge') {
      unresolvedConflicts.push({
        key,
        local: localCookie,
        remote: remoteCookie,
      });
      continue;
    } else {
      const freshness = compareCookieFreshness(localCookie, remoteCookie);
      winner = freshness >= 0 ? localCookie : remoteCookie;
      resolution = 'LWW';
    }

    conflicts.push({
      key,
      local: localCookie,
      remote: remoteCookie,
      winner: winner === localCookie ? 'local' : 'remote',
      resolution,
    });
    mergedCookies.push(winner);
  }

  return {
    cookies: mergedCookies.sort((left, right) => cookieIdentity(left).localeCompare(cookieIdentity(right))),
    conflicts,
    unresolvedConflicts,
    conflictPolicy: resolvedPolicy,
  };
}

export function createChromeCookieStore({ chromeApi = globalThis.chrome, domainWhitelist = [] } = {}) {
  if (!chromeApi?.cookies) {
    throw createCodeError('cookie.api_missing', 'chrome.cookies API is required.');
  }

  const baseWhitelist = normalizeDomainWhitelist(domainWhitelist);

  function resolveWhitelist(overrideWhitelist) {
    if (overrideWhitelist === undefined) {
      return baseWhitelist;
    }

    return normalizeDomainWhitelist(overrideWhitelist);
  }

  async function readCookies({ domainWhitelist: overrideWhitelist } = {}) {
    const whitelist = resolveWhitelist(overrideWhitelist);
    const cookies = await callChromeCookiesApi(chromeApi, 'getAll', {});
    const now = nowIso();

    return (cookies ?? [])
      .map((cookie) => normalizeCookieRecord(cookie, now))
      .filter((cookie) => matchesDomainWhitelist(cookie.domain, whitelist));
  }

  async function writeCookies(cookies = [], { domainWhitelist: overrideWhitelist } = {}) {
    const whitelist = resolveWhitelist(overrideWhitelist);
    const normalizedCookies = cookies.map((cookie) => normalizeCookieRecord(cookie));

    let written = 0;
    let skipped = 0;

    for (const cookie of normalizedCookies) {
      if (!matchesDomainWhitelist(cookie.domain, whitelist)) {
        skipped += 1;
        continue;
      }

      await callChromeCookiesApi(chromeApi, 'set', toChromeSetDetails(cookie));
      written += 1;
    }

    return {
      written,
      skipped,
    };
  }

  async function removeCookies(cookies = [], { domainWhitelist: overrideWhitelist } = {}) {
    const whitelist = resolveWhitelist(overrideWhitelist);
    const normalizedCookies = cookies.map((cookie) => normalizeCookieRecord(cookie));

    let removed = 0;
    for (const cookie of normalizedCookies) {
      if (!matchesDomainWhitelist(cookie.domain, whitelist)) {
        continue;
      }

      await callChromeCookiesApi(chromeApi, 'remove', toChromeRemoveDetails(cookie));
      removed += 1;
    }

    return { removed };
  }

  async function replaceCookies(cookies = [], { domainWhitelist: overrideWhitelist } = {}) {
    const existingCookies = await readCookies({ domainWhitelist: overrideWhitelist });
    await removeCookies(existingCookies, { domainWhitelist: overrideWhitelist });
    const writeSummary = await writeCookies(cookies, { domainWhitelist: overrideWhitelist });

    return {
      removed: existingCookies.length,
      written: writeSummary.written,
      skipped: writeSummary.skipped,
    };
  }

  return {
    domainWhitelist: [...baseWhitelist],
    readCookies,
    writeCookies,
    removeCookies,
    replaceCookies,
  };
}

export function createInMemoryCookieStore(initialCookies = [], options = {}) {
  const baseWhitelist = normalizeDomainWhitelist(options.domainWhitelist ?? []);
  let cookieJar = initialCookies.map((cookie) => normalizeCookieRecord(cookie));

  function filterCookies(cookies, whitelist) {
    return cookies.filter((cookie) => matchesDomainWhitelist(cookie.domain, whitelist));
  }

  return {
    async readCookies({ domainWhitelist } = {}) {
      const whitelist = domainWhitelist === undefined ? baseWhitelist : normalizeDomainWhitelist(domainWhitelist);
      return cloneJson(filterCookies(cookieJar, whitelist));
    },
    async writeCookies(cookies = [], { domainWhitelist } = {}) {
      const whitelist = domainWhitelist === undefined ? baseWhitelist : normalizeDomainWhitelist(domainWhitelist);
      let written = 0;
      let skipped = 0;

      for (const rawCookie of cookies) {
        const cookie = normalizeCookieRecord(rawCookie);
        if (!matchesDomainWhitelist(cookie.domain, whitelist)) {
          skipped += 1;
          continue;
        }

        const key = cookieIdentity(cookie);
        const existingIndex = cookieJar.findIndex((item) => cookieIdentity(item) === key);
        if (existingIndex >= 0) {
          cookieJar[existingIndex] = cookie;
        } else {
          cookieJar.push(cookie);
        }
        written += 1;
      }

      return {
        written,
        skipped,
      };
    },
    async replaceCookies(cookies = [], { domainWhitelist } = {}) {
      const whitelist = domainWhitelist === undefined ? baseWhitelist : normalizeDomainWhitelist(domainWhitelist);
      const retained = cookieJar.filter((cookie) => !matchesDomainWhitelist(cookie.domain, whitelist));
      const incoming = cookies
        .map((cookie) => normalizeCookieRecord(cookie))
        .filter((cookie) => matchesDomainWhitelist(cookie.domain, whitelist));

      cookieJar = [...retained, ...incoming];

      return {
        removed: 0,
        written: incoming.length,
        skipped: 0,
      };
    },
    async removeCookies(cookies = [], { domainWhitelist } = {}) {
      const whitelist = domainWhitelist === undefined ? baseWhitelist : normalizeDomainWhitelist(domainWhitelist);
      const keysToRemove = new Set(
        cookies
          .map((cookie) => normalizeCookieRecord(cookie))
          .filter((cookie) => matchesDomainWhitelist(cookie.domain, whitelist))
          .map((cookie) => cookieIdentity(cookie))
      );

      const before = cookieJar.length;
      cookieJar = cookieJar.filter((cookie) => !keysToRemove.has(cookieIdentity(cookie)));

      return {
        removed: before - cookieJar.length,
      };
    },
    getState() {
      return cloneJson(cookieJar);
    },
  };
}

export function createCookieSyncOrchestrator(options = {}) {
  const cookieStore = options.cookieStore;
  const gistClient = options.gistClient;
  const encryptionPassword = options.encryptionPassword;
  const deviceId = options.deviceId;
  const domainWhitelist = normalizeDomainWhitelist(options.domainWhitelist ?? []);
  const now = options.now ?? nowIso;

  if (!cookieStore || typeof cookieStore.readCookies !== 'function' || typeof cookieStore.replaceCookies !== 'function') {
    throw createCodeError(
      'sync.invalid_cookie_store',
      'cookieStore with readCookies and replaceCookies methods is required.'
    );
  }

  if (!gistClient || typeof gistClient.upsertSyncGist !== 'function' || typeof gistClient.getSyncGist !== 'function') {
    throw createCodeError(
      'sync.invalid_gist_client',
      'gistClient with getSyncGist and upsertSyncGist methods is required.'
    );
  }

  if (typeof encryptionPassword !== 'string' || !encryptionPassword.trim()) {
    throw createCodeError('sync.invalid_password', 'encryptionPassword is required.');
  }

  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throw createCodeError('sync.invalid_device', 'deviceId is required.');
  }

  const retryOptions = {
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    initialBackoffMs: options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
    maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    jitterFactor: options.jitterFactor ?? DEFAULT_JITTER_FACTOR,
    sleepFn: options.sleepFn ?? sleep,
    randomFn: options.randomFn ?? Math.random,
    onRetry: options.onRetry,
  };

  async function loadNextManifestVersion() {
    if (typeof gistClient.loadMetadata !== 'function') {
      return 1;
    }

    const metadata = await gistClient.loadMetadata();
    const version = Number(metadata?.sync?.manifestVersion);
    if (Number.isInteger(version) && version >= 0) {
      return version + 1;
    }

    return 1;
  }

  async function createManifestFromCookies(cookies) {
    const manifestVersion = await loadNextManifestVersion();
    const payload = {
      schema: COOKIE_SYNC_SCHEMA,
      generatedAt: now(),
      deviceId,
      cookies,
    };

    return createEncryptedManifest({
      manifestPayload: payload,
      password: encryptionPassword,
      version: manifestVersion,
      meta: {
        schema: `${COOKIE_SYNC_SCHEMA}-encrypted`,
        cookieCount: cookies.length,
        generatedBy: 'cookie-sync-orchestrator',
      },
    });
  }

  async function getRemotePayload({ required } = {}) {
    try {
      const { result, attempt } = await executeWithRetry(
        async () => gistClient.getSyncGist(),
        retryOptions
      );

      const payload = await decryptManifestPayload({
        manifest: result.manifest,
        password: encryptionPassword,
        validateChecksum: true,
      });

      if (!payload || payload.schema !== COOKIE_SYNC_SCHEMA || !Array.isArray(payload.cookies)) {
        throw createCodeError('sync.invalid_payload', 'Remote payload does not match expected cookie sync schema.');
      }

      return {
        payload,
        attempt,
      };
    } catch (error) {
      if (!required && error?.code === 'gist.missing_id') {
        return {
          payload: null,
          attempt: 0,
        };
      }

      throw error;
    }
  }

  async function applyCookiesWithRollback(nextCookies, snapshotCookies) {
    try {
      await cookieStore.replaceCookies(nextCookies, { domainWhitelist });
    } catch (applyError) {
      try {
        await cookieStore.replaceCookies(snapshotCookies, { domainWhitelist });
      } catch (rollbackError) {
        const rollbackFailed = createCodeError(
          'sync.rollback_failed',
          'Failed to apply merged cookies and rollback restoration also failed.'
        );
        rollbackFailed.cause = applyError;
        rollbackFailed.rollbackError = rollbackError;
        throw rollbackFailed;
      }

      const rollbackApplied = createCodeError(
        'sync.rollback_applied',
        'Failed to apply merged cookies. Snapshot rollback completed successfully.'
      );
      rollbackApplied.cause = applyError;
      throw rollbackApplied;
    }
  }

  async function uploadCookies(cookies) {
    const filteredCookies = normalizeAndFilterCookies(cookies, domainWhitelist);
    const manifest = await createManifestFromCookies(filteredCookies);
    const { result, attempt } = await executeWithRetry(
      async () =>
        gistClient.upsertSyncGist({
          manifest,
          deviceId,
        }),
      retryOptions
    );

    return {
      upload: result,
      attempt,
      manifest,
      cookies: filteredCookies,
    };
  }

  async function pushLocalToCloud() {
    const localCookies = normalizeAndFilterCookies(
      await cookieStore.readCookies({ domainWhitelist }),
      domainWhitelist
    );
    const { upload, attempt, manifest } = await uploadCookies(localCookies);

    return {
      direction: 'push',
      localCookieCount: localCookies.length,
      manifestVersion: manifest.version,
      uploadAttempt: attempt,
      upload,
    };
  }

  async function pullRemoteToLocal({ conflictPolicy = DEFAULT_CONFLICT_POLICY } = {}) {
    const resolvedPolicy = normalizeConflictPolicy(conflictPolicy);
    const snapshotCookies = normalizeAndFilterCookies(
      await cookieStore.readCookies({ domainWhitelist }),
      domainWhitelist
    );
    const remote = await getRemotePayload({ required: false });

    if (!remote.payload) {
      return {
        direction: 'pull',
        status: 'noop',
        reason: 'remote_missing',
        localCookieCount: snapshotCookies.length,
      };
    }

    const filteredRemoteCookies = normalizeAndFilterCookies(remote.payload.cookies, domainWhitelist);

    const merged = mergeCookieCollections({
      localCookies: snapshotCookies,
      remoteCookies: filteredRemoteCookies,
      conflictPolicy: resolvedPolicy,
    });

    if (merged.unresolvedConflicts.length > 0) {
      throw createCodeError(
        'sync.conflict',
        'Manual merge is required before applying remote cookies.',
        {
          conflictPolicy: resolvedPolicy,
          conflicts: merged.unresolvedConflicts,
        }
      );
    }

    await applyCookiesWithRollback(merged.cookies, snapshotCookies);

    return {
      direction: 'pull',
      status: 'applied',
      pullAttempt: remote.attempt,
      conflictCount: merged.conflicts.length,
      mergedCookieCount: merged.cookies.length,
    };
  }

  async function syncBidirectional({ conflictPolicy = DEFAULT_CONFLICT_POLICY } = {}) {
    const resolvedPolicy = normalizeConflictPolicy(conflictPolicy);
    const snapshotCookies = normalizeAndFilterCookies(
      await cookieStore.readCookies({ domainWhitelist }),
      domainWhitelist
    );
    const remote = await getRemotePayload({ required: false });
    const remoteCookies = normalizeAndFilterCookies(remote.payload?.cookies ?? [], domainWhitelist);

    const merged = mergeCookieCollections({
      localCookies: snapshotCookies,
      remoteCookies,
      conflictPolicy: resolvedPolicy,
    });

    if (merged.unresolvedConflicts.length > 0) {
      throw createCodeError(
        'sync.conflict',
        'Manual merge is required before bidirectional sync can continue.',
        {
          conflictPolicy: resolvedPolicy,
          conflicts: merged.unresolvedConflicts,
        }
      );
    }

    await applyCookiesWithRollback(merged.cookies, snapshotCookies);
    const { upload, attempt, manifest } = await uploadCookies(merged.cookies);

    return {
      direction: 'bidirectional',
      status: 'synced',
      remotePullAttempt: remote.attempt,
      uploadAttempt: attempt,
      conflictCount: merged.conflicts.length,
      mergedCookieCount: merged.cookies.length,
      manifestVersion: manifest.version,
      upload,
    };
  }

  return {
    pushLocalToCloud,
    pullRemoteToLocal,
    syncBidirectional,
  };
}
