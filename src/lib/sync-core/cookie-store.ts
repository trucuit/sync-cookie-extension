/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

/**
 * Chrome Cookie Store — read, write, remove, and replace cookies via chrome.cookies API.
 * Supports domain whitelist filtering.
 */

function createCodeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeDomain(value) {
  if (value === undefined || value === null) return '';
  return `${value}`.trim().toLowerCase().replace(/^\.+/, '');
}

function normalizeDomainWhitelist(domainWhitelist = []) {
  if (!Array.isArray(domainWhitelist)) return [];
  const normalized = domainWhitelist
    .map((value) => normalizeDomain(value))
    .filter(Boolean);
  return [...new Set(normalized)].sort();
}

function matchesDomainWhitelist(domain, domainWhitelist = []) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedWhitelist = normalizeDomainWhitelist(domainWhitelist);
  if (!normalizedDomain) return false;
  if (normalizedWhitelist.length === 0) return true;
  return normalizedWhitelist.some(
    (entry) => normalizedDomain === entry || normalizedDomain.endsWith(`.${entry}`)
  );
}

function normalizeSameSite(value) {
  if (!value) return 'Unspecified';
  const normalized = `${value}`.trim().toLowerCase();
  if (normalized === 'no_restriction' || normalized === 'none') return 'None';
  if (normalized === 'strict') return 'Strict';
  if (normalized === 'lax') return 'Lax';
  return 'Unspecified';
}

function toChromeSameSite(value) {
  const normalized = normalizeSameSite(value);
  if (normalized === 'None') return 'no_restriction';
  if (normalized === 'Strict') return 'strict';
  if (normalized === 'Lax') return 'lax';
  return 'unspecified';
}

function toIsoOrNull(value) {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'number' ? value : Date.parse(`${value}`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function maybeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCookieRecord(cookie = {}, now = new Date().toISOString()) {
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

function deriveCookieUrl(cookie) {
  if (typeof cookie.url === 'string' && cookie.url.trim()) return cookie.url;
  const hostname = normalizeDomain(cookie.domain);
  if (!hostname) {
    throw createCodeError('cookie.invalid_domain', 'Cookie domain is required to derive URL.');
  }
  const protocol = cookie.secure ? 'https' : 'http';
  const path = cookie.path ?? '/';
  return `${protocol}://${hostname}${path.startsWith('/') ? path : `/${path}`}`;
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

function isPromiseLike(value) {
  return Boolean(value) && typeof value.then === 'function';
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

export function createChromeCookieStore({ chromeApi = globalThis.chrome, domainWhitelist = [] } = {}) {
  if (!chromeApi?.cookies) {
    throw createCodeError('cookie.api_missing', 'chrome.cookies API is required.');
  }

  const baseWhitelist = normalizeDomainWhitelist(domainWhitelist);

  function resolveWhitelist(overrideWhitelist) {
    if (overrideWhitelist === undefined) return baseWhitelist;
    return normalizeDomainWhitelist(overrideWhitelist);
  }

  async function readCookies({ domainWhitelist: overrideWhitelist } = {}) {
    const whitelist = resolveWhitelist(overrideWhitelist);
    const cookies = await callChromeCookiesApi(chromeApi, 'getAll', {});
    const now = new Date().toISOString();

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

    return { written, skipped };
  }

  async function removeCookies(cookies = [], { domainWhitelist: overrideWhitelist } = {}) {
    const whitelist = resolveWhitelist(overrideWhitelist);
    const normalizedCookies = cookies.map((cookie) => normalizeCookieRecord(cookie));

    let removed = 0;
    for (const cookie of normalizedCookies) {
      if (!matchesDomainWhitelist(cookie.domain, whitelist)) continue;
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
