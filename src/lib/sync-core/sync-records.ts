import supportedDomains from './supported-domains.json';

export type SyncPushRecord = {
  domain: string;
  payload: string;
};

export type SyncStoredRecord = SyncPushRecord & {
  updatedAt: string | null;
};

export type LegacySyncRecord = {
  payload: string;
  updatedAt: string | null;
};

type CookieLike = {
  domain?: string | null;
};

export const SUPPORTED_SYNC_DOMAINS = [...supportedDomains];
export const DEFAULT_DOMAIN_WHITELIST = [...SUPPORTED_SYNC_DOMAINS];

export function normalizeDomain(value: string | null | undefined) {
  if (value === undefined || value === null) return '';
  return `${value}`.trim().toLowerCase().replace(/^\.+/, '');
}

export function findDomainMatch(domain: string | null | undefined, domainWhitelist = SUPPORTED_SYNC_DOMAINS) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) return null;

  const matches = [...domainWhitelist]
    .map((entry) => normalizeDomain(entry))
    .filter(Boolean)
    .filter((entry) => normalizedDomain === entry || normalizedDomain.endsWith(`.${entry}`))
    .sort((left, right) => right.length - left.length);

  return matches[0] ?? null;
}

export function normalizeDomainWhitelist(domainWhitelist: Array<string | null | undefined> = []) {
  const normalized = domainWhitelist
    .map((value) => findDomainMatch(value))
    .filter((value): value is string => Boolean(value));

  return [...new Set(normalized)].sort();
}

export function parseDomainWhitelistInput(input: string) {
  return normalizeDomainWhitelist(input.split(/[\n,]+/));
}

export function toDomainKey(domain: string) {
  return normalizeDomain(domain).replace(/\./g, ',');
}

export function fromDomainKey(domainKey: string) {
  return `${domainKey}`.trim().toLowerCase().replace(/,/g, '.');
}

export function buildCookieHostPermissions(domainWhitelist = SUPPORTED_SYNC_DOMAINS) {
  return normalizeDomainWhitelist(domainWhitelist).flatMap((domain) => ([
    `https://${domain}/*`,
    `http://${domain}/*`,
    `https://*.${domain}/*`,
    `http://*.${domain}/*`,
  ]));
}

export function groupCookiesByDomain<T extends CookieLike>(cookies: T[], domainWhitelist = DEFAULT_DOMAIN_WHITELIST) {
  const normalizedWhitelist = domainWhitelist.length > 0
    ? normalizeDomainWhitelist(domainWhitelist)
    : DEFAULT_DOMAIN_WHITELIST;

  return cookies.reduce<Record<string, T[]>>((grouped, cookie) => {
    const matchedDomain = findDomainMatch(cookie?.domain, normalizedWhitelist);
    if (!matchedDomain) {
      return grouped;
    }

    grouped[matchedDomain] ??= [];
    grouped[matchedDomain].push(cookie);
    return grouped;
  }, {});
}
