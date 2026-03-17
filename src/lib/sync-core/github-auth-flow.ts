/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import {
  PBKDF2_ITERATIONS,
  decryptUtf8WithPassword,
  encryptUtf8WithPassword,
} from './gist-sync-crypto';

const DEFAULT_GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GITHUB_SCOPE = 'gist';
const DEFAULT_TOKEN_STORAGE_KEY = 'pat.github.oauth.token.v1';
const DEFAULT_TOKEN_VALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function createCodeError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

function parseJsonSafe(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizePassword(password) {
  if (typeof password !== 'string' || !password.trim()) {
    throw createCodeError('auth.password_required', 'Password is required to decrypt/store GitHub token.');
  }

  return password;
}

function normalizeStorage(storage) {
  if (!storage) {
    throw createCodeError('auth.storage_missing', 'storage adapter is required.');
  }

  const hasMethods =
    typeof storage.getItem === 'function' &&
    typeof storage.setItem === 'function' &&
    typeof storage.removeItem === 'function';

  if (!hasMethods) {
    throw createCodeError('auth.storage_missing', 'storage adapter must implement getItem/setItem/removeItem.');
  }

  return storage;
}

function normalizeState(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createCodeError('auth.invalid_state', 'OAuth state is required.');
  }

  return value;
}

function parseStoredTokenState(rawValue) {
  if (!rawValue) {
    return null;
  }

  if (typeof rawValue === 'string') {
    return parseJsonSafe(rawValue);
  }

  if (typeof rawValue === 'object') {
    return rawValue;
  }

  return null;
}

function combinePasswordWithDeviceEntropy(password, deviceEntropy) {
  const normalizedPassword = normalizePassword(password);
  const entropyValue = typeof deviceEntropy === 'string' && deviceEntropy.trim() ? deviceEntropy : 'device-entropy-not-set';

  return `${normalizedPassword}::${entropyValue}`;
}

function normalizeOAuthConfig({ clientId, redirectUri }) {
  if (!clientId || typeof clientId !== 'string') {
    throw createCodeError('auth.config_missing', 'GitHub OAuth clientId is required.');
  }

  if (!redirectUri || typeof redirectUri !== 'string') {
    throw createCodeError('auth.config_missing', 'GitHub OAuth redirectUri is required.');
  }

  return {
    clientId,
    redirectUri,
  };
}

export function createInMemoryKeyValueStore(initialState = {}) {
  const stateMap = new Map(Object.entries(initialState));

  return {
    async getItem(key) {
      return stateMap.has(key) ? stateMap.get(key) : null;
    },
    async setItem(key, value) {
      stateMap.set(key, value);
    },
    async removeItem(key) {
      stateMap.delete(key);
    },
    async dump() {
      return Object.fromEntries(stateMap.entries());
    },
  };
}

export function parseGitHubOAuthCallbackUrl(callbackUrl, { expectedState } = {}) {
  let parsed;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw createCodeError('auth.invalid_callback_url', 'OAuth callback URL is invalid.');
  }

  const oauthError = parsed.searchParams.get('error');
  if (oauthError) {
    if (oauthError === 'access_denied') {
      throw createCodeError('auth.user_denied', 'GitHub permission was denied by user.');
    }

    throw createCodeError('auth.callback_error', `GitHub OAuth callback returned error: ${oauthError}`);
  }

  const code = parsed.searchParams.get('code');
  if (!code) {
    throw createCodeError('auth.missing_code', 'OAuth callback does not include authorization code.');
  }

  const state = parsed.searchParams.get('state');
  if (expectedState && state !== expectedState) {
    throw createCodeError('auth.invalid_state', 'OAuth state mismatch. Possible CSRF or stale callback.');
  }

  return {
    code,
    state,
  };
}

export function createGitHubOAuthClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw createCodeError('auth.fetch_missing', 'fetch implementation is required.');
  }

  const env = options.env ?? (typeof process !== 'undefined' ? process.env : {});
  const storage = normalizeStorage(options.storage ?? createInMemoryKeyValueStore());
  const oauthProxyExchangeUrl = options.oauthProxyExchangeUrl ?? env.GITHUB_OAUTH_PROXY_URL ?? null;
  const githubApiBaseUrl = (options.githubApiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, '');
  const authorizeUrl = options.authorizeUrl ?? DEFAULT_GITHUB_AUTHORIZE_URL;
  const oauthConfig = normalizeOAuthConfig({
    clientId: options.clientId ?? env.GITHUB_CLIENT_ID,
    redirectUri: options.redirectUri ?? env.GITHUB_OAUTH_REDIRECT_URI,
  });
  const nowFn = options.nowFn ?? Date.now;
  const tokenStorageKey = options.tokenStorageKey ?? DEFAULT_TOKEN_STORAGE_KEY;
  const tokenValidationIntervalMs = Number(options.tokenValidationIntervalMs ?? DEFAULT_TOKEN_VALIDATE_INTERVAL_MS);
  const deviceEntropy = options.deviceEntropy ?? env.SYNC_DEVICE_ENTROPY ?? 'sync-cookie-device';
  const encryptionIterations = Number(options.encryptionIterations ?? PBKDF2_ITERATIONS);

  if (!Number.isFinite(tokenValidationIntervalMs) || tokenValidationIntervalMs < 0) {
    throw createCodeError('auth.config_invalid', 'tokenValidationIntervalMs must be a non-negative number.');
  }

  if (!Number.isInteger(encryptionIterations) || encryptionIterations <= 0) {
    throw createCodeError('auth.config_invalid', 'encryptionIterations must be a positive integer.');
  }

  async function readTokenState() {
    const raw = await storage.getItem(tokenStorageKey);
    const parsed = parseStoredTokenState(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  }

  async function writeTokenState(tokenState) {
    await storage.setItem(tokenStorageKey, tokenState);
  }

  async function clearAccessToken() {
    await storage.removeItem(tokenStorageKey);
  }

  async function storeAccessToken({ accessToken, password, metadata = {} }) {
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      throw createCodeError('auth.invalid_token', 'accessToken must be a non-empty string.');
    }

    const createdAt = nowFn();
    const passwordMaterial = combinePasswordWithDeviceEntropy(password, deviceEntropy);
    const encryptedToken = await encryptUtf8WithPassword({
      plaintext: accessToken,
      password: passwordMaterial,
      iterations: encryptionIterations,
    });

    const tokenState = {
      schema: 'pat-github-token-v1',
      createdAt,
      updatedAt: createdAt,
      lastValidatedAt: null,
      isValid: true,
      encryptedToken,
      metadata: {
        scope: metadata.scope ?? DEFAULT_GITHUB_SCOPE,
        tokenType: metadata.tokenType ?? 'bearer',
        expiresIn: metadata.expiresIn ?? null,
      },
    };

    await writeTokenState(tokenState);
    return tokenState;
  }

  async function loadAccessToken({ password } = {}) {
    const tokenState = await readTokenState();
    if (!tokenState) {
      return null;
    }

    const passwordMaterial = combinePasswordWithDeviceEntropy(password, deviceEntropy);

    let accessToken;
    try {
      accessToken = await decryptUtf8WithPassword({
        encryptedPayload: tokenState.encryptedToken,
        password: passwordMaterial,
      });
    } catch (error) {
      const decryptionError = createCodeError(
        'auth.token_decrypt_failed',
        'Stored token cannot be decrypted with current password/device entropy. Re-authentication is required.'
      );
      decryptionError.cause = error;
      throw decryptionError;
    }

    return {
      accessToken,
      tokenState,
    };
  }

  async function validateAccessToken({ accessToken }) {
    if (!accessToken) {
      throw createCodeError('auth.invalid_token', 'accessToken is required for validation.');
    }

    let response;
    try {
      response = await fetchImpl(`${githubApiBaseUrl}/user`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (error) {
      const validationError = createCodeError('auth.validation_failed', 'Unable to validate GitHub token due to network error.');
      validationError.cause = error;
      throw validationError;
    }

    if (response.ok) {
      return {
        valid: true,
        status: response.status,
      };
    }

    return {
      valid: false,
      status: response.status,
      reauthRequired: response.status === 401,
    };
  }

  async function getAccessToken({ password, forceValidate = false } = {}) {
    let loaded;
    try {
      loaded = await loadAccessToken({ password });
    } catch (error) {
      if (error.code === 'auth.token_decrypt_failed') {
        await clearAccessToken();
        const reauthError = createCodeError(
          'auth.reauthentication_required',
          'Stored GitHub token became unreadable. Please reconnect GitHub.'
        );
        reauthError.cause = error;
        throw reauthError;
      }

      throw error;
    }

    if (!loaded) {
      return null;
    }

    const currentTime = nowFn();
    const lastValidatedAt = loaded.tokenState.lastValidatedAt ?? null;
    const shouldValidate =
      forceValidate ||
      !lastValidatedAt ||
      currentTime - Number(lastValidatedAt) >= tokenValidationIntervalMs;

    if (!shouldValidate) {
      return loaded.accessToken;
    }

    const validation = await validateAccessToken({ accessToken: loaded.accessToken });

    if (!validation.valid && validation.reauthRequired) {
      await clearAccessToken();
      throw createCodeError('auth.reauthentication_required', 'GitHub token is invalid or revoked. Please reconnect GitHub.', 401);
    }

    const nextTokenState = {
      ...loaded.tokenState,
      updatedAt: currentTime,
      lastValidatedAt: currentTime,
      isValid: validation.valid,
    };
    await writeTokenState(nextTokenState);

    if (!validation.valid) {
      throw createCodeError(
        'auth.validation_failed',
        `GitHub token validation failed with status ${validation.status}.`,
        validation.status
      );
    }

    return loaded.accessToken;
  }

  function buildAuthorizationUrl({ state, scope = DEFAULT_GITHUB_SCOPE, allowSignup = false, additionalParams = {} } = {}) {
    const url = new URL(authorizeUrl);
    url.searchParams.set('client_id', oauthConfig.clientId);
    url.searchParams.set('redirect_uri', oauthConfig.redirectUri);
    url.searchParams.set('scope', scope);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', normalizeState(state));
    url.searchParams.set('allow_signup', allowSignup ? 'true' : 'false');

    for (const [key, value] of Object.entries(additionalParams)) {
      if (value === undefined || value === null) {
        continue;
      }

      url.searchParams.set(key, `${value}`);
    }

    return url.toString();
  }

  async function exchangeCodeForToken({ code }) {
    if (typeof code !== 'string' || !code.trim()) {
      throw createCodeError('auth.missing_code', 'OAuth authorization code is required for token exchange.');
    }

    if (!oauthProxyExchangeUrl) {
      throw createCodeError(
        'auth.proxy_not_configured',
        'OAuth proxy URL is not configured. Set GITHUB_OAUTH_PROXY_URL and implement backend token exchange endpoint.'
      );
    }

    let response;
    try {
      response = await fetchImpl(oauthProxyExchangeUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId: oauthConfig.clientId,
          redirectUri: oauthConfig.redirectUri,
          code,
        }),
      });
    } catch (error) {
      const proxyError = createCodeError(
        'auth.proxy_unreachable',
        'Authentication service unavailable. Verify OAuth proxy URL and network connectivity.'
      );
      proxyError.cause = error;
      throw proxyError;
    }

    const raw = await response.text();
    const payload = parseJsonSafe(raw);

    if (!response.ok) {
      const message =
        payload?.error_description ??
        payload?.error ??
        payload?.message ??
        `OAuth token exchange failed with status ${response.status}.`;

      throw createCodeError(
        response.status >= 500 ? 'auth.service_unavailable' : 'auth.exchange_failed',
        message,
        response.status
      );
    }

    const accessToken = payload?.access_token ?? payload?.accessToken;
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      throw createCodeError('auth.exchange_failed', 'OAuth proxy response does not include access_token.', response.status);
    }

    return {
      accessToken,
      tokenType: payload?.token_type ?? payload?.tokenType ?? 'bearer',
      scope: payload?.scope ?? DEFAULT_GITHUB_SCOPE,
      expiresIn: Number.isFinite(Number(payload?.expires_in)) ? Number(payload.expires_in) : null,
    };
  }

  async function handleOAuthCallback({ callbackUrl, expectedState, password }) {
    const callback = parseGitHubOAuthCallbackUrl(callbackUrl, { expectedState });
    const exchange = await exchangeCodeForToken({ code: callback.code });

    await storeAccessToken({
      accessToken: exchange.accessToken,
      password,
      metadata: {
        scope: exchange.scope,
        tokenType: exchange.tokenType,
        expiresIn: exchange.expiresIn,
      },
    });

    return exchange;
  }

  return {
    oauthProxyExchangeUrl,
    clientId: oauthConfig.clientId,
    redirectUri: oauthConfig.redirectUri,
    buildAuthorizationUrl,
    parseGitHubOAuthCallbackUrl,
    exchangeCodeForToken,
    handleOAuthCallback,
    storeAccessToken,
    loadAccessToken,
    getAccessToken,
    validateAccessToken,
    clearAccessToken,
  };
}
