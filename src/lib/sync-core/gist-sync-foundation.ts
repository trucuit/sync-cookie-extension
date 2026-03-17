/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { nowIso } from './fixtures';
import { assertManifestChecksum } from './gist-sync-crypto';

const GIST_SCHEMA = 'pat-gist-sync-v1';
const METADATA_SCHEMA_VERSION = 1;
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GIST_FILENAME = 'sync-cookie-manifest.json';
const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 5;
const MIN_AUTO_SYNC_INTERVAL_MINUTES = 1;
const MAX_AUTO_SYNC_INTERVAL_MINUTES = 60;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJsonSafe(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeDomainWhitelist(domainWhitelist = []) {
  if (!Array.isArray(domainWhitelist)) {
    return [];
  }

  const normalized = domainWhitelist
    .map((value) => `${value}`.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(normalized)].sort();
}

export function normalizeSyncSettings(syncSettings = {}) {
  const rawInterval = syncSettings.autoSyncIntervalMinutes ?? DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
  const parsedInterval = Number(rawInterval);

  if (!Number.isFinite(parsedInterval)) {
    throw new Error('autoSyncIntervalMinutes must be a number between 1 and 60');
  }

  const autoSyncIntervalMinutes = Math.floor(parsedInterval);
  if (
    autoSyncIntervalMinutes < MIN_AUTO_SYNC_INTERVAL_MINUTES ||
    autoSyncIntervalMinutes > MAX_AUTO_SYNC_INTERVAL_MINUTES
  ) {
    throw new Error('autoSyncIntervalMinutes must be between 1 and 60');
  }

  return {
    autoSyncIntervalMinutes,
    domainWhitelist: normalizeDomainWhitelist(syncSettings.domainWhitelist ?? []),
  };
}

function normalizeMetadata(raw = {}, { gistFilename, syncSettings }) {
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    gist: {
      id: raw?.gist?.id ?? null,
      filename: raw?.gist?.filename ?? gistFilename,
      revision: raw?.gist?.revision ?? null,
      updatedAt: raw?.gist?.updatedAt ?? null,
      etag: raw?.gist?.etag ?? null,
    },
    sync: {
      version: Number.isInteger(raw?.sync?.version) ? raw.sync.version : 0,
      checksum: raw?.sync?.checksum ?? null,
      manifestVersion: Number.isInteger(raw?.sync?.manifestVersion) ? raw.sync.manifestVersion : null,
      lastSyncedAt: raw?.sync?.lastSyncedAt ?? null,
      deviceId: raw?.sync?.deviceId ?? null,
    },
    settings: normalizeSyncSettings(raw?.settings ?? syncSettings),
  };
}

export function createInMemorySyncMetadataStore(options = {}) {
  const baseState = normalizeMetadata(options.initialState, {
    gistFilename: options.gistFilename ?? DEFAULT_GIST_FILENAME,
    syncSettings: options.syncSettings,
  });

  let state = cloneJson(baseState);

  return {
    async load() {
      return cloneJson(state);
    },
    async save(nextState) {
      state = normalizeMetadata(nextState, {
        gistFilename: options.gistFilename ?? DEFAULT_GIST_FILENAME,
        syncSettings: options.syncSettings,
      });
      return cloneJson(state);
    },
  };
}

export function createFileSyncMetadataStore({ filePath, gistFilename = DEFAULT_GIST_FILENAME, syncSettings }) {
  void filePath;
  void gistFilename;
  void syncSettings;
  throw new Error('createFileSyncMetadataStore is not supported in browser extension runtime');
}

function mapGitHubErrorCode(status, message = '') {
  if (status === 401) {
    return 'auth.invalid_token';
  }

  if (status === 429) {
    return 'rate.limited';
  }

  if (status === 403 && message.toLowerCase().includes('rate limit')) {
    return 'rate.limited';
  }

  if (status === 404) {
    return 'gist.not_found';
  }

  return 'request.failed';
}

function ensureManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('manifest is required');
  }

  if (!manifest.payload || !manifest.checksum || typeof manifest.version !== 'number') {
    throw new Error('manifest must include version, payload and checksum');
  }
}

async function ensureManifestIntegrity(manifest) {
  ensureManifest(manifest);

  try {
    await assertManifestChecksum(manifest);
  } catch (error) {
    const checksumError = new Error('manifest checksum validation failed');
    checksumError.code = 'manifest.checksum_mismatch';
    checksumError.cause = error;
    throw checksumError;
  }
}

function buildSyncDocument({ manifest, syncVersion, deviceId, syncSettings }) {
  return {
    schema: GIST_SCHEMA,
    generatedAt: nowIso(),
    sync: {
      version: syncVersion,
      checksum: manifest.checksum,
      manifestVersion: manifest.version,
      deviceId,
      autoSyncIntervalMinutes: syncSettings.autoSyncIntervalMinutes,
      domainWhitelist: syncSettings.domainWhitelist,
    },
    manifest,
  };
}

function normalizeGistSummary(gist, filename) {
  if (!gist?.id) {
    throw new Error('GitHub API did not return gist id');
  }

  const fileEntry = gist?.files?.[filename] ?? Object.values(gist?.files ?? {})[0];
  if (!fileEntry) {
    throw new Error(`Gist ${gist.id} does not contain sync payload file`);
  }

  const revision = Array.isArray(gist.history) && gist.history.length > 0 ? gist.history[0].version : null;
  return {
    id: gist.id,
    fileEntry,
    revision,
    updatedAt: gist.updated_at ?? nowIso(),
  };
}

async function parseDocumentFromFileEntry({ fetchImpl, token, fileEntry }) {
  if (typeof fileEntry.content === 'string' && !fileEntry.truncated) {
    return parseJsonSafe(fileEntry.content);
  }

  if (!fileEntry.raw_url) {
    return null;
  }

  const response = await fetchImpl(fileEntry.raw_url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const error = new Error(`Failed to fetch gist raw payload (${response.status})`);
    error.code = mapGitHubErrorCode(response.status, response.statusText);
    error.status = response.status;
    throw error;
  }

  const raw = await response.text();
  return parseJsonSafe(raw);
}

export function createGitHubCredentialProvider({
  accessToken,
  env = typeof process !== 'undefined' ? process.env : {},
  oauthProxyUrl,
  oauthClient,
  tokenPassword,
  getTokenPassword,
} = {}) {
  const resolvedToken = accessToken ?? env.GITHUB_GIST_TOKEN ?? null;
  const resolvedProxyUrl = oauthProxyUrl ?? env.GITHUB_OAUTH_PROXY_URL ?? oauthClient?.oauthProxyExchangeUrl ?? null;

  return async function getAccessToken() {
    if (resolvedToken) {
      return resolvedToken;
    }

    if (oauthClient && typeof oauthClient.getAccessToken === 'function') {
      const resolvedPassword =
        typeof getTokenPassword === 'function' ? await getTokenPassword() : tokenPassword;

      const oauthToken = await oauthClient.getAccessToken({
        password: resolvedPassword,
        forceValidate: false,
      });

      if (oauthToken) {
        return oauthToken;
      }
    }

    const error = new Error(
      resolvedProxyUrl
        ? `Missing GitHub access token. Complete OAuth flow and token exchange via ${resolvedProxyUrl}, then persist encrypted token in runtime storage.`
        : 'Missing GitHub access token. Set GITHUB_GIST_TOKEN for local testing or configure GITHUB_OAUTH_PROXY_URL + runtime OAuth token storage.'
    );
    error.code = 'auth.missing_token';
    throw error;
  };
}

export function createGitHubGistSyncClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl is required');
  }

  if (!options.metadataStore || typeof options.metadataStore.load !== 'function' || typeof options.metadataStore.save !== 'function') {
    throw new Error('metadataStore with load/save methods is required');
  }

  if (typeof options.getAccessToken !== 'function') {
    throw new Error('getAccessToken function is required');
  }

  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, '');
  const gistFilename = options.gistFilename ?? DEFAULT_GIST_FILENAME;
  const syncSettings = normalizeSyncSettings(options.syncSettings ?? {});
  const userAgent = options.userAgent ?? 'sync-cookie-extension-foundation/0.1';

  async function githubRequest(pathname, { method = 'GET', token, body } = {}) {
    const response = await fetchImpl(`${apiBaseUrl}${pathname}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': userAgent,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    const json = parseJsonSafe(text);

    if (!response.ok) {
      const error = new Error(json?.message ?? `GitHub request failed with status ${response.status}`);
      error.code = mapGitHubErrorCode(response.status, json?.message ?? response.statusText ?? '');
      error.status = response.status;
      error.responseBody = json;

      const retryAfterHeader = response.headers.get('retry-after');
      if (retryAfterHeader !== null) {
        error.retryAfter = retryAfterHeader;
        const parsedRetryAfter = Number(retryAfterHeader);
        if (Number.isFinite(parsedRetryAfter) && parsedRetryAfter >= 0) {
          error.retryAfterSeconds = parsedRetryAfter;
        }
      }

      throw error;
    }

    return {
      json,
      etag: response.headers.get('etag'),
    };
  }

  async function loadMetadata() {
    const metadata = await options.metadataStore.load();
    return normalizeMetadata(metadata, { gistFilename, syncSettings });
  }

  async function saveMetadata(nextMetadata) {
    return options.metadataStore.save(
      normalizeMetadata(nextMetadata, {
        gistFilename,
        syncSettings,
      })
    );
  }

  async function getSyncGist({ gistId } = {}) {
    const token = await options.getAccessToken();
    const metadata = await loadMetadata();
    const resolvedGistId = gistId ?? metadata.gist.id;

    if (!resolvedGistId) {
      const error = new Error('No gist id available. Create a sync gist first.');
      error.code = 'gist.missing_id';
      throw error;
    }

    const response = await githubRequest(`/gists/${encodeURIComponent(resolvedGistId)}`, {
      token,
    });

    const gistSummary = normalizeGistSummary(response.json, metadata.gist.filename);
    const document = await parseDocumentFromFileEntry({
      fetchImpl,
      token,
      fileEntry: gistSummary.fileEntry,
    });

    if (!document || document.schema !== GIST_SCHEMA) {
      const error = new Error(`Gist ${resolvedGistId} does not contain ${GIST_SCHEMA} payload`);
      error.code = 'gist.invalid_payload';
      throw error;
    }

    await ensureManifestIntegrity(document.manifest);

    const nextMetadata = {
      ...metadata,
      gist: {
        ...metadata.gist,
        id: gistSummary.id,
        filename: gistSummary.fileEntry.filename ?? metadata.gist.filename,
        revision: gistSummary.revision,
        updatedAt: gistSummary.updatedAt,
        etag: response.etag,
      },
      sync: {
        ...metadata.sync,
        version: document.sync?.version ?? metadata.sync.version,
        checksum: document.sync?.checksum ?? metadata.sync.checksum,
        manifestVersion: document.sync?.manifestVersion ?? metadata.sync.manifestVersion,
        lastSyncedAt: nowIso(),
        deviceId: document.sync?.deviceId ?? metadata.sync.deviceId,
      },
    };

    await saveMetadata(nextMetadata);

    return {
      gistId: gistSummary.id,
      revision: gistSummary.revision,
      manifest: document.manifest,
      sync: document.sync,
      filename: gistSummary.fileEntry.filename,
    };
  }

  async function createSyncGist({ manifest, deviceId, description = 'Sync Cookie Extension data (MVP)' }) {
    await ensureManifestIntegrity(manifest);

    const token = await options.getAccessToken();
    const metadata = await loadMetadata();
    const syncVersion = Math.max(metadata.sync.version, 0) + 1;
    const nextDocument = buildSyncDocument({
      manifest,
      syncVersion,
      deviceId,
      syncSettings: metadata.settings,
    });

    const payload = {
      description,
      public: false,
      files: {
        [metadata.gist.filename]: {
          content: JSON.stringify(nextDocument, null, 2),
        },
      },
    };

    const response = await githubRequest('/gists', {
      method: 'POST',
      token,
      body: payload,
    });

    const gistSummary = normalizeGistSummary(response.json, metadata.gist.filename);
    const nextMetadata = {
      ...metadata,
      gist: {
        ...metadata.gist,
        id: gistSummary.id,
        filename: gistSummary.fileEntry.filename ?? metadata.gist.filename,
        revision: gistSummary.revision,
        updatedAt: gistSummary.updatedAt,
        etag: response.etag,
      },
      sync: {
        ...metadata.sync,
        version: syncVersion,
        checksum: manifest.checksum,
        manifestVersion: manifest.version,
        lastSyncedAt: nowIso(),
        deviceId,
      },
    };

    await saveMetadata(nextMetadata);

    return {
      gistId: gistSummary.id,
      revision: gistSummary.revision,
      syncVersion,
      manifestVersion: manifest.version,
      checksum: manifest.checksum,
    };
  }

  async function updateSyncGist({ gistId, manifest, deviceId, description }) {
    await ensureManifestIntegrity(manifest);

    const metadata = await loadMetadata();
    const token = await options.getAccessToken();
    const resolvedGistId = gistId ?? metadata.gist.id;

    if (!resolvedGistId) {
      const error = new Error('Cannot update gist before createSyncGist initializes gist id');
      error.code = 'gist.missing_id';
      throw error;
    }

    const syncVersion = Math.max(metadata.sync.version, 0) + 1;
    const nextDocument = buildSyncDocument({
      manifest,
      syncVersion,
      deviceId: deviceId ?? metadata.sync.deviceId,
      syncSettings: metadata.settings,
    });

    const payload = {
      ...(description ? { description } : null),
      files: {
        [metadata.gist.filename]: {
          content: JSON.stringify(nextDocument, null, 2),
        },
      },
    };

    const response = await githubRequest(`/gists/${encodeURIComponent(resolvedGistId)}`, {
      method: 'PATCH',
      token,
      body: payload,
    });

    const gistSummary = normalizeGistSummary(response.json, metadata.gist.filename);
    const nextMetadata = {
      ...metadata,
      gist: {
        ...metadata.gist,
        id: gistSummary.id,
        filename: gistSummary.fileEntry.filename ?? metadata.gist.filename,
        revision: gistSummary.revision,
        updatedAt: gistSummary.updatedAt,
        etag: response.etag,
      },
      sync: {
        ...metadata.sync,
        version: syncVersion,
        checksum: manifest.checksum,
        manifestVersion: manifest.version,
        lastSyncedAt: nowIso(),
        deviceId: deviceId ?? metadata.sync.deviceId,
      },
    };

    await saveMetadata(nextMetadata);

    return {
      gistId: gistSummary.id,
      revision: gistSummary.revision,
      syncVersion,
      manifestVersion: manifest.version,
      checksum: manifest.checksum,
    };
  }

  async function upsertSyncGist(input) {
    const metadata = await loadMetadata();
    if (metadata.gist.id) {
      return updateSyncGist({
        ...input,
        gistId: metadata.gist.id,
      });
    }

    return createSyncGist(input);
  }

  return {
    createSyncGist,
    getSyncGist,
    updateSyncGist,
    upsertSyncGist,
    loadMetadata,
  };
}
