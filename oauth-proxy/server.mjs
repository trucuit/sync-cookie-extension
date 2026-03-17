import http from 'node:http';

const EXCHANGE_ENDPOINT_PATH = '/oauth/github/exchange';
const FIREBASE_AUTH_REGISTER_PATH = '/firebase/auth/register';
const FIREBASE_AUTH_LOGIN_PATH = '/firebase/auth/login';
const FIREBASE_AUTH_REFRESH_PATH = '/firebase/auth/refresh';
const FIREBASE_SYNC_PUSH_PATH = '/firebase/sync/push';
const FIREBASE_SYNC_PULL_PATH = '/firebase/sync/pull';

const GITHUB_EXCHANGE_URL = 'https://github.com/login/oauth/access_token';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_SIZE_BYTES = 16 * 1024;
const MAX_SYNC_PAYLOAD_BYTES = 512 * 1024;

const port = parsePort(process.env.PORT ?? '8787');

const githubClientId = optionalEnv('GITHUB_OAUTH_CLIENT_ID');
const githubClientSecret = optionalEnv('GITHUB_OAUTH_CLIENT_SECRET');
const firebaseApiKey = optionalEnv('FIREBASE_API_KEY');
const firebaseDbUrl = optionalEnv('FIREBASE_DB_URL')?.replace(/\/+$/, '') ?? null;

const allowedOrigins = parseCommaList(
  process.env.PROXY_ALLOWED_ORIGINS
  ?? process.env.GITHUB_OAUTH_ALLOWED_ORIGINS
  ?? process.env.FIREBASE_ALLOWED_ORIGINS
  ?? '',
);
const allowedRedirectUriPrefixes = parseCommaList(process.env.GITHUB_OAUTH_ALLOWED_REDIRECT_URI_PREFIXES ?? '');
const rateLimitMax = parsePositiveInt(process.env.PROXY_RATE_LIMIT_MAX, 120);
const rateLimitWindowMs = parsePositiveInt(process.env.PROXY_RATE_LIMIT_WINDOW_MS, 60_000);
const requestCounters = new Map();

function optionalEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function parsePositiveInt(value, fallback) {
  if (!value || !value.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parsePort(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }

  return parsed;
}

function parseCommaList(raw) {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isChromeExtensionOrigin(origin) {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function resolveCorsOrigin(origin) {
  if (!origin) {
    return null;
  }

  if (allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin) ? origin : null;
  }

  if (isChromeExtensionOrigin(origin)) {
    return origin;
  }

  if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
    return origin;
  }

  return null;
}

function writeJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function applyCorsHeaders(request, response) {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : null;
  const allowedOrigin = resolveCorsOrigin(origin);

  if (origin && !allowedOrigin) {
    writeJson(response, 403, {
      error: 'cors_forbidden',
      message: 'Origin is not allowed.',
    });
    return false;
  }

  if (allowedOrigin) {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Vary', 'Origin');
  }

  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  return true;
}

function getRequestIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return request.socket.remoteAddress ?? 'unknown';
}

function enforceRateLimit(request, response) {
  const ip = getRequestIp(request);
  const now = Date.now();

  const current = requestCounters.get(ip);
  if (!current || now - current.windowStart >= rateLimitWindowMs) {
    requestCounters.set(ip, {
      windowStart: now,
      count: 1,
    });
    return true;
  }

  current.count += 1;
  if (current.count > rateLimitMax) {
    writeJson(response, 429, {
      error: 'rate_limited',
      message: `Too many requests. Retry after ${Math.ceil(rateLimitWindowMs / 1000)} seconds.`,
    });
    return false;
  }

  return true;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    request.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_SIZE_BYTES) {
        reject(createHttpError(413, 'request_too_large', `Request body exceeds ${MAX_BODY_SIZE_BYTES} bytes.`));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('error', (error) => {
      reject(createHttpError(400, 'request_stream_error', error.message));
    });

    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8').trim();
      if (!rawBody) {
        reject(createHttpError(400, 'invalid_payload', 'JSON body is required.'));
        return;
      }

      try {
        const parsed = JSON.parse(rawBody);
        resolve(parsed);
      } catch {
        reject(createHttpError(400, 'invalid_json', 'Request body must be valid JSON.'));
      }
    });
  });
}

function createHttpError(status, code, message) {
  return { status, code, message };
}

function normalizeStringField(input, fieldName) {
  if (typeof input !== 'string' || !input.trim()) {
    throw createHttpError(400, 'invalid_payload', `${fieldName} must be a non-empty string.`);
  }

  return input.trim();
}

function validateRedirectUri(redirectUri) {
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== 'https:') {
      throw new Error('redirectUri must use https protocol.');
    }
  } catch {
    throw createHttpError(400, 'invalid_redirect_uri', 'redirectUri must be a valid https URL.');
  }

  if (allowedRedirectUriPrefixes.length === 0) {
    return;
  }

  const isAllowed = allowedRedirectUriPrefixes.some((prefix) => redirectUri.startsWith(prefix));
  if (!isAllowed) {
    throw createHttpError(400, 'redirect_uri_forbidden', 'redirectUri is not in allowed prefix list.');
  }
}

function ensureGithubConfig() {
  if (!githubClientId || !githubClientSecret) {
    throw createHttpError(
      503,
      'service_unconfigured',
      'GitHub OAuth proxy is not configured. Missing GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET.',
    );
  }
}

function ensureFirebaseConfig() {
  if (!firebaseApiKey || !firebaseDbUrl) {
    throw createHttpError(
      503,
      'service_unconfigured',
      'Firebase proxy is not configured. Missing FIREBASE_API_KEY/FIREBASE_DB_URL.',
    );
  }
}

async function fetchJson(url, init, networkCode, networkMessage) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    return { response, payload };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createHttpError(504, `${networkCode}_timeout`, `${networkMessage} timed out.`);
    }

    throw createHttpError(502, `${networkCode}_unavailable`, networkMessage);
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeCodeForToken({ code, redirectUri }) {
  ensureGithubConfig();

  const body = new URLSearchParams({
    client_id: githubClientId,
    client_secret: githubClientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const { response, payload } = await fetchJson(
    GITHUB_EXCHANGE_URL,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
    'github_exchange',
    'Failed to reach GitHub exchange endpoint.',
  );

  if (!response.ok) {
    throw createHttpError(502, 'github_exchange_failed', `GitHub exchange request failed (${response.status}).`);
  }

  if (!payload?.access_token) {
    const message = typeof payload?.error_description === 'string'
      ? payload.error_description
      : 'GitHub response missing access_token.';
    throw createHttpError(401, 'github_exchange_rejected', message);
  }

  return {
    access_token: payload.access_token,
    token_type: payload.token_type ?? 'bearer',
    scope: payload.scope ?? null,
  };
}

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

  if (typeof errorCode !== 'string' || !errorCode.trim()) {
    return 'Firebase request failed.';
  }

  const baseCode = errorCode.split(':')[0].trim();
  return messages[baseCode] ?? errorCode;
}

async function firebaseAuthExchange(action, payload) {
  ensureFirebaseConfig();

  const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${encodeURIComponent(firebaseApiKey)}`;
  const { response, payload: data } = await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    'firebase_auth',
    'Cannot connect to Firebase Auth.',
  );

  if (!response.ok) {
    const firebaseError = data?.error?.message ?? 'Firebase auth failed.';
    throw createHttpError(401, 'firebase_auth_failed', firebaseErrorMessage(firebaseError));
  }

  return data ?? {};
}

async function firebaseRefresh(refreshToken) {
  ensureFirebaseConfig();

  const endpoint = `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(firebaseApiKey)}`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const { response, payload: data } = await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
    'firebase_refresh',
    'Cannot connect to Firebase token service.',
  );

  if (!response.ok) {
    throw createHttpError(401, 'firebase_refresh_failed', 'Session expired. Please login again.');
  }

  return {
    idToken: data?.id_token,
    refreshToken: data?.refresh_token,
    uid: data?.user_id,
  };
}

async function verifyFirebaseIdToken(idToken) {
  ensureFirebaseConfig();

  const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`;
  const { response, payload: data } = await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ idToken }),
    },
    'firebase_lookup',
    'Cannot validate Firebase session.',
  );

  if (!response.ok) {
    throw createHttpError(401, 'firebase_invalid_token', 'Session expired. Please login again.');
  }

  const uid = data?.users?.[0]?.localId;
  if (typeof uid !== 'string' || !uid.trim()) {
    throw createHttpError(401, 'firebase_invalid_token', 'Invalid Firebase token payload.');
  }

  return uid.trim();
}

async function firebaseSyncPush({ idToken, payload }) {
  ensureFirebaseConfig();

  if (Buffer.byteLength(payload, 'utf8') > MAX_SYNC_PAYLOAD_BYTES) {
    throw createHttpError(413, 'payload_too_large', `Encrypted payload exceeds ${MAX_SYNC_PAYLOAD_BYTES} bytes.`);
  }

  const uid = await verifyFirebaseIdToken(idToken);
  const updatedAt = new Date().toISOString();
  const endpoint = `${firebaseDbUrl}/sync/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(idToken)}`;

  const { response, payload: data } = await fetchJson(
    endpoint,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payload,
        updatedAt,
      }),
    },
    'firebase_push',
    'Cannot connect to Firebase Database.',
  );

  if (!response.ok) {
    throw createHttpError(
      response.status,
      'firebase_push_failed',
      data?.error ?? 'Failed to push cookie data.',
    );
  }

  return { ok: true, updatedAt, uid };
}

async function firebaseSyncPull({ idToken }) {
  ensureFirebaseConfig();

  const uid = await verifyFirebaseIdToken(idToken);
  const endpoint = `${firebaseDbUrl}/sync/${encodeURIComponent(uid)}.json?auth=${encodeURIComponent(idToken)}`;

  const { response, payload: data } = await fetchJson(
    endpoint,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    },
    'firebase_pull',
    'Cannot connect to Firebase Database.',
  );

  if (!response.ok) {
    throw createHttpError(
      response.status,
      'firebase_pull_failed',
      data?.error ?? 'Failed to pull cookie data.',
    );
  }

  if (!data || !data.payload) {
    throw createHttpError(404, 'firebase_no_data', 'No synced data found. Push cookies first.');
  }

  return {
    ok: true,
    payload: data.payload,
    updatedAt: data.updatedAt ?? null,
    uid,
  };
}

async function handleGithubExchange(payload) {
  const code = normalizeStringField(payload?.code, 'code');
  const receivedClientId = normalizeStringField(payload?.clientId, 'clientId');
  const redirectUri = normalizeStringField(payload?.redirectUri, 'redirectUri');

  ensureGithubConfig();

  if (receivedClientId !== githubClientId) {
    throw createHttpError(400, 'client_id_mismatch', 'clientId does not match configured OAuth app.');
  }

  validateRedirectUri(redirectUri);

  return exchangeCodeForToken({
    code,
    redirectUri,
  });
}

async function handleFirebaseRegister(payload) {
  const email = normalizeStringField(payload?.email, 'email');
  const password = normalizeStringField(payload?.password, 'password');

  const data = await firebaseAuthExchange('signUp', {
    email,
    password,
    returnSecureToken: true,
  });

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    email: data.email,
  };
}

async function handleFirebaseLogin(payload) {
  const email = normalizeStringField(payload?.email, 'email');
  const password = normalizeStringField(payload?.password, 'password');

  const data = await firebaseAuthExchange('signInWithPassword', {
    email,
    password,
    returnSecureToken: true,
  });

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    email: data.email,
  };
}

async function handleFirebaseRefresh(payload) {
  const refreshToken = normalizeStringField(payload?.refreshToken, 'refreshToken');
  return firebaseRefresh(refreshToken);
}

async function handleFirebasePush(payload) {
  const idToken = normalizeStringField(payload?.idToken, 'idToken');
  const encryptedPayload = normalizeStringField(payload?.payload, 'payload');
  return firebaseSyncPush({ idToken, payload: encryptedPayload });
}

async function handleFirebasePull(payload) {
  const idToken = normalizeStringField(payload?.idToken, 'idToken');
  return firebaseSyncPull({ idToken });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (requestUrl.pathname === '/healthz' && request.method === 'GET') {
    writeJson(response, 200, {
      ok: true,
      service: 'sync-cookie-proxy',
      exchangePath: EXCHANGE_ENDPOINT_PATH,
      hasOriginAllowList: allowedOrigins.length > 0,
      hasRedirectAllowList: allowedRedirectUriPrefixes.length > 0,
      hasGithubConfig: Boolean(githubClientId && githubClientSecret),
      hasFirebaseConfig: Boolean(firebaseApiKey && firebaseDbUrl),
      rateLimit: {
        max: rateLimitMax,
        windowMs: rateLimitWindowMs,
      },
    });
    return;
  }

  const isKnownRoute = [
    EXCHANGE_ENDPOINT_PATH,
    FIREBASE_AUTH_REGISTER_PATH,
    FIREBASE_AUTH_LOGIN_PATH,
    FIREBASE_AUTH_REFRESH_PATH,
    FIREBASE_SYNC_PUSH_PATH,
    FIREBASE_SYNC_PULL_PATH,
  ].includes(requestUrl.pathname);

  if (!isKnownRoute) {
    writeJson(response, 404, {
      error: 'not_found',
      message: 'Route not found.',
    });
    return;
  }

  if (!applyCorsHeaders(request, response)) {
    return;
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== 'POST') {
    writeJson(response, 405, {
      error: 'method_not_allowed',
      message: 'Only POST is supported for this endpoint.',
    });
    return;
  }

  if (!enforceRateLimit(request, response)) {
    return;
  }

  try {
    const payload = await readJsonBody(request);

    let result;
    switch (requestUrl.pathname) {
      case EXCHANGE_ENDPOINT_PATH:
        result = await handleGithubExchange(payload);
        break;
      case FIREBASE_AUTH_REGISTER_PATH:
        result = await handleFirebaseRegister(payload);
        break;
      case FIREBASE_AUTH_LOGIN_PATH:
        result = await handleFirebaseLogin(payload);
        break;
      case FIREBASE_AUTH_REFRESH_PATH:
        result = await handleFirebaseRefresh(payload);
        break;
      case FIREBASE_SYNC_PUSH_PATH:
        result = await handleFirebasePush(payload);
        break;
      case FIREBASE_SYNC_PULL_PATH:
        result = await handleFirebasePull(payload);
        break;
      default:
        throw createHttpError(404, 'not_found', 'Route not found.');
    }

    writeJson(response, 200, result);
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    const code = typeof error?.code === 'string' ? error.code : 'internal_error';
    const message = typeof error?.message === 'string' ? error.message : 'Internal server error.';

    writeJson(response, status, {
      error: code,
      message,
    });
  }
});

server.listen(port, () => {
  console.log(`Proxy is listening on port ${port}`);
  console.log(`GitHub exchange endpoint: ${EXCHANGE_ENDPOINT_PATH}`);
  console.log(`Firebase auth register endpoint: ${FIREBASE_AUTH_REGISTER_PATH}`);
  console.log(`Firebase auth login endpoint: ${FIREBASE_AUTH_LOGIN_PATH}`);
  console.log(`Firebase auth refresh endpoint: ${FIREBASE_AUTH_REFRESH_PATH}`);
  console.log(`Firebase sync push endpoint: ${FIREBASE_SYNC_PUSH_PATH}`);
  console.log(`Firebase sync pull endpoint: ${FIREBASE_SYNC_PULL_PATH}`);
});
