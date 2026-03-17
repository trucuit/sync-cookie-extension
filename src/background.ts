/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck

import { createCookieSyncOrchestrator, createChromeCookieStore } from './lib/sync-core/cookie-sync-orchestrator';
import {
  createGitHubCredentialProvider,
  createGitHubGistSyncClient,
  normalizeSyncSettings,
} from './lib/sync-core/gist-sync-foundation';
import { createGitHubOAuthClient } from './lib/sync-core/github-auth-flow';

const STORAGE_KEYS = {
  token: 'pat.github.oauth.token.v1',
  profile: 'pat.github.profile.v1',
  metadata: 'pat.github.sync.metadata.v1',
  settings: 'pat.github.sync.settings.v1',
  runtimeState: 'pat.github.sync.runtime.v1',
  deviceId: 'pat.github.sync.device-id.v1',
  sessionPassword: 'pat.github.sync.session-password.v1',
} as const;

const AUTO_SYNC_ALARM = 'pat.github.auto-sync';
const DEFAULT_SETTINGS = normalizeSyncSettings({
  autoSyncIntervalMinutes: 5,
  domainWhitelist: [],
});

const ENV_CONFIG = {
  githubClientId: import.meta.env.VITE_GITHUB_CLIENT_ID ?? '',
  oauthProxyUrl: import.meta.env.VITE_GITHUB_OAUTH_PROXY_URL ?? '',
  gistFilename: import.meta.env.VITE_GITHUB_GIST_FILENAME ?? 'sync-cookie-manifest.json',
};

function createCodeError(code: string, message: string, status?: number) {
  const error = new Error(message) as Error & { code?: string; status?: number };
  error.code = code;
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

function requireOAuthConfig() {
  if (!ENV_CONFIG.githubClientId) {
    throw createCodeError('auth.config_missing', 'Thiếu VITE_GITHUB_CLIENT_ID trong môi trường build extension.');
  }

  if (!ENV_CONFIG.oauthProxyUrl) {
    throw createCodeError('auth.config_missing', 'Thiếu VITE_GITHUB_OAUTH_PROXY_URL để exchange OAuth code.');
  }
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

async function getOrCreateDeviceId() {
  const existing = await getLocalValue<string | null>(STORAGE_KEYS.deviceId, null);
  if (existing) {
    return existing;
  }

  const created = globalThis.crypto?.randomUUID?.() ?? `device-${Date.now()}`;
  await setLocalValue(STORAGE_KEYS.deviceId, created);
  return created;
}

function createOAuthStorageAdapter() {
  return {
    async getItem(key: string) {
      const result = await chrome.storage.local.get(key);
      return result[key] ?? null;
    },
    async setItem(key: string, value: unknown) {
      await chrome.storage.local.set({ [key]: value });
    },
    async removeItem(key: string) {
      await chrome.storage.local.remove(key);
    },
  };
}

function createMetadataStore() {
  return {
    async load() {
      return getLocalValue(STORAGE_KEYS.metadata, {});
    },
    async save(nextState: unknown) {
      await setLocalValue(STORAGE_KEYS.metadata, nextState);
      return nextState;
    },
  };
}

async function loadSyncSettings() {
  const raw = await getLocalValue<Record<string, unknown> | null>(STORAGE_KEYS.settings, null);
  return normalizeSyncSettings(raw ?? DEFAULT_SETTINGS);
}

async function saveSyncSettings(input: Record<string, unknown>) {
  const normalized = normalizeSyncSettings(input);
  await setLocalValue(STORAGE_KEYS.settings, normalized);
  await chrome.alarms.create(AUTO_SYNC_ALARM, {
    periodInMinutes: normalized.autoSyncIntervalMinutes,
  });
  return normalized;
}

async function loadRuntimeState() {
  return getLocalValue(STORAGE_KEYS.runtimeState, null);
}

async function saveRuntimeState(state: Record<string, unknown>) {
  await setLocalValue(STORAGE_KEYS.runtimeState, {
    ...state,
    updatedAt: new Date().toISOString(),
  });
}

async function fetchGitHubProfile(accessToken: string) {
  const response = await fetch('https://api.github.com/user', {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw createCodeError('auth.profile_fetch_failed', `Không thể lấy thông tin GitHub profile (${response.status})`, response.status);
  }

  const profile = await response.json();
  return {
    login: profile?.login ?? null,
    id: profile?.id ?? null,
    avatarUrl: profile?.avatar_url ?? null,
    htmlUrl: profile?.html_url ?? null,
  };
}

function launchWebAuthFlow(authUrl: string) {
  return new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      {
        url: authUrl,
        interactive: true,
      },
      (callbackUrl) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(createCodeError('auth.launch_failed', runtimeError.message ?? 'Không thể mở GitHub OAuth flow'));
          return;
        }

        if (!callbackUrl) {
          reject(createCodeError('auth.callback_missing', 'Không nhận được callback URL từ GitHub OAuth flow.'));
          return;
        }

        resolve(callbackUrl);
      }
    );
  });
}

async function createOAuthClient() {
  const deviceEntropy = await getOrCreateDeviceId();

  return createGitHubOAuthClient({
    clientId: ENV_CONFIG.githubClientId,
    redirectUri: chrome.identity.getRedirectURL('github-callback'),
    oauthProxyExchangeUrl: ENV_CONFIG.oauthProxyUrl,
    storage: createOAuthStorageAdapter(),
    deviceEntropy,
  });
}

async function createSyncRuntime(password: string) {
  if (!password || !password.trim()) {
    throw createCodeError('sync.password_required', 'Cần nhập password để mã hoá/decrypt dữ liệu sync.');
  }

  const settings = await loadSyncSettings();
  const metadataStore = createMetadataStore();
  const oauthClient = await createOAuthClient();
  const getAccessToken = createGitHubCredentialProvider({
    oauthClient,
    tokenPassword: password,
    oauthProxyUrl: ENV_CONFIG.oauthProxyUrl,
  });

  const gistClient = createGitHubGistSyncClient({
    metadataStore,
    getAccessToken,
    gistFilename: ENV_CONFIG.gistFilename,
    syncSettings: settings,
  });

  const cookieStore = createChromeCookieStore({
    chromeApi: chrome,
    domainWhitelist: settings.domainWhitelist,
  });

  const deviceId = await getOrCreateDeviceId();
  const orchestrator = createCookieSyncOrchestrator({
    cookieStore,
    gistClient,
    encryptionPassword: password,
    deviceId,
    domainWhitelist: settings.domainWhitelist,
  });

  return {
    settings,
    orchestrator,
    gistClient,
  };
}

async function getStatusSnapshot() {
  const [tokenState, profile, metadata, settings, runtimeState, sessionPassword] = await Promise.all([
    getLocalValue(STORAGE_KEYS.token, null),
    getLocalValue(STORAGE_KEYS.profile, null),
    getLocalValue(STORAGE_KEYS.metadata, {}),
    loadSyncSettings(),
    loadRuntimeState(),
    getSessionValue<string | null>(STORAGE_KEYS.sessionPassword, null),
  ]);

  return {
    auth: {
      connected: Boolean(tokenState),
      tokenStored: Boolean(tokenState),
      profile,
      config: {
        hasGithubClientId: Boolean(ENV_CONFIG.githubClientId),
        hasOAuthProxyUrl: Boolean(ENV_CONFIG.oauthProxyUrl),
      },
    },
    sync: {
      metadata: {
        gistId: metadata?.gist?.id ?? null,
        revision: metadata?.gist?.revision ?? null,
        lastSyncedAt: metadata?.sync?.lastSyncedAt ?? null,
        manifestVersion: metadata?.sync?.manifestVersion ?? null,
        syncVersion: metadata?.sync?.version ?? 0,
      },
      settings,
      runtimeState,
      hasSessionPassword: Boolean(sessionPassword),
    },
  };
}

async function handleAuthConnect(password: string) {
  requireOAuthConfig();

  if (!password || !password.trim()) {
    throw createCodeError('auth.password_required', 'Nhập password để bảo vệ OAuth token trước khi connect.');
  }

  const oauthClient = await createOAuthClient();
  const state = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
  const authUrl = oauthClient.buildAuthorizationUrl({ state });
  const callbackUrl = await launchWebAuthFlow(authUrl);
  await oauthClient.handleOAuthCallback({
    callbackUrl,
    expectedState: state,
    password,
  });

  const accessToken = await oauthClient.getAccessToken({
    password,
    forceValidate: true,
  });

  if (!accessToken) {
    throw createCodeError('auth.exchange_failed', 'OAuth flow hoàn tất nhưng không lấy được access token.');
  }

  const profile = await fetchGitHubProfile(accessToken);
  await setLocalValue(STORAGE_KEYS.profile, profile);
  await setSessionValue(STORAGE_KEYS.sessionPassword, password);

  return {
    connected: true,
    profile,
  };
}

async function handleAuthDisconnect() {
  const oauthClient = await createOAuthClient();
  await oauthClient.clearAccessToken();
  await removeLocalValue(STORAGE_KEYS.profile);
  await removeSessionValue(STORAGE_KEYS.sessionPassword);

  return {
    connected: false,
  };
}

async function runSync(mode: 'push' | 'pull' | 'bidirectional', password: string, source: 'manual' | 'auto') {
  const runtime = await createSyncRuntime(password);

  let result;
  if (mode === 'push') {
    result = await runtime.orchestrator.pushLocalToCloud();
  } else if (mode === 'pull') {
    result = await runtime.orchestrator.pullRemoteToLocal();
  } else {
    result = await runtime.orchestrator.syncBidirectional();
  }

  await setSessionValue(STORAGE_KEYS.sessionPassword, password);
  await saveRuntimeState({
    source,
    mode,
    status: 'success',
    result,
  });

  return result;
}

async function runAutoSyncIfPossible() {
  try {
    const password = await getSessionValue<string | null>(STORAGE_KEYS.sessionPassword, null);
    if (!password) {
      await saveRuntimeState({
        source: 'auto',
        mode: 'bidirectional',
        status: 'skipped',
        reason: 'missing_session_password',
      });
      return;
    }

    await runSync('bidirectional', password, 'auto');
  } catch (error) {
    await saveRuntimeState({
      source: 'auto',
      mode: 'bidirectional',
      status: 'error',
      error: serializeError(error),
    });
  }
}

async function initializeSyncDefaults() {
  const savedSettings = await getLocalValue<Record<string, unknown> | null>(STORAGE_KEYS.settings, null);
  if (!savedSettings) {
    await saveSyncSettings(DEFAULT_SETTINGS);
    return;
  }

  await saveSyncSettings(savedSettings);
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Sync Cookie Extension installed');
  void initializeSyncDefaults();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSyncDefaults();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) {
    void runAutoSyncIfPossible();
  }
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    switch (request?.type) {
      case 'SYNC_GET_STATUS': {
        const data = await getStatusSnapshot();
        sendResponse({ ok: true, data });
        return;
      }

      case 'AUTH_CONNECT': {
        const data = await handleAuthConnect(request.password ?? '');
        sendResponse({ ok: true, data });
        return;
      }

      case 'AUTH_DISCONNECT': {
        const data = await handleAuthDisconnect();
        sendResponse({ ok: true, data });
        return;
      }

      case 'SYNC_SET_SETTINGS': {
        const settings = await saveSyncSettings({
          autoSyncIntervalMinutes: request.autoSyncIntervalMinutes,
          domainWhitelist: request.domainWhitelist,
        });
        sendResponse({ ok: true, data: settings });
        return;
      }

      case 'SYNC_RUN': {
        const mode = request.mode ?? 'bidirectional';
        const password = request.password ?? '';
        const result = await runSync(mode, password, 'manual');
        const status = await getStatusSnapshot();
        sendResponse({ ok: true, data: { result, status } });
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
