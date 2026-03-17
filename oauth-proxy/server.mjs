import http from 'node:http';

const EXCHANGE_ENDPOINT_PATH = '/oauth/github/exchange';
const GITHUB_EXCHANGE_URL = 'https://github.com/login/oauth/access_token';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_SIZE_BYTES = 16 * 1024;

const port = parsePort(process.env.PORT ?? '8787');
const clientId = ensureEnv('GITHUB_OAUTH_CLIENT_ID');
const clientSecret = ensureEnv('GITHUB_OAUTH_CLIENT_SECRET');
const allowedOrigins = parseCommaList(process.env.GITHUB_OAUTH_ALLOWED_ORIGINS ?? '');
const allowedRedirectUriPrefixes = parseCommaList(process.env.GITHUB_OAUTH_ALLOWED_REDIRECT_URI_PREFIXES ?? '');

function ensureEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required.`);
  }

  return value.trim();
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

async function exchangeCodeForToken({ code, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(GITHUB_EXCHANGE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw createHttpError(502, 'github_exchange_failed', `GitHub exchange request failed (${response.status}).`);
    }

    if (!payload?.access_token) {
      const message = typeof payload?.error_description === 'string' ? payload.error_description : 'GitHub response missing access_token.';
      throw createHttpError(401, 'github_exchange_rejected', message);
    }

    return {
      access_token: payload.access_token,
      token_type: payload.token_type ?? 'bearer',
      scope: payload.scope ?? null,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createHttpError(504, 'github_exchange_timeout', 'GitHub exchange request timed out.');
    }

    if (error && typeof error === 'object' && 'status' in error && 'code' in error) {
      throw error;
    }

    throw createHttpError(502, 'github_exchange_unavailable', 'Failed to reach GitHub exchange endpoint.');
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (requestUrl.pathname === '/healthz' && request.method === 'GET') {
    writeJson(response, 200, {
      ok: true,
      service: 'sync-cookie-oauth-proxy',
      exchangePath: EXCHANGE_ENDPOINT_PATH,
      hasOriginAllowList: allowedOrigins.length > 0,
      hasRedirectAllowList: allowedRedirectUriPrefixes.length > 0,
    });
    return;
  }

  if (requestUrl.pathname !== EXCHANGE_ENDPOINT_PATH) {
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

  try {
    const payload = await readJsonBody(request);
    const code = normalizeStringField(payload?.code, 'code');
    const receivedClientId = normalizeStringField(payload?.clientId, 'clientId');
    const redirectUri = normalizeStringField(payload?.redirectUri, 'redirectUri');

    if (receivedClientId !== clientId) {
      throw createHttpError(400, 'client_id_mismatch', 'clientId does not match configured OAuth app.');
    }

    validateRedirectUri(redirectUri);

    const tokenPayload = await exchangeCodeForToken({
      code,
      redirectUri,
    });

    writeJson(response, 200, tokenPayload);
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
  console.log(`OAuth proxy is listening on port ${port}`);
  console.log(`Exchange endpoint: ${EXCHANGE_ENDPOINT_PATH}`);
});
