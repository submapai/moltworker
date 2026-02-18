/**
 * Moltbot + Cloudflare Sandbox
 *
 * This Worker runs Moltbot personal AI assistant in a Cloudflare Sandbox container.
 * It proxies all requests to the Moltbot Gateway's web UI and WebSocket endpoint.
 *
 * Features:
 * - Web UI (Control Dashboard + WebChat) at /
 * - WebSocket support for real-time communication
 * - Admin UI at /_admin/ for device management
 * - Configuration via environment secrets
 *
 * Required secrets (set via `wrangler secret put`):
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *
 * Optional secrets:
 * - MOLTBOT_GATEWAY_TOKEN: Token to protect gateway access
 * - TELEGRAM_BOT_TOKEN: Telegram bot token
 * - DISCORD_BOT_TOKEN: Discord bot token
 * - SLACK_BOT_TOKEN + SLACK_APP_TOKEN: Slack tokens
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, MoltbotEnv } from './types';
import { MOLTBOT_PORT } from './config';
import { createAccessMiddleware } from './auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess, syncToR2 } from './gateway';
import { publicRoutes, api, adminUi, debug, cdp } from './routes';
import { redactSensitiveParams } from './utils/logging';
import loadingPageHtml from './assets/loading.html?raw';
import configErrorHtml from './assets/config-error.html?raw';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }

  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }

  return message;
}

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function matchesWebhookPath(pathname: string, webhookPath: string): boolean {
  return pathname === webhookPath || pathname.startsWith(`${webhookPath}/`);
}

function isPublicChannelWebhookPath(pathname: string, env: MoltbotEnv): boolean {
  if (matchesWebhookPath(pathname, '/blooio')) return true;
  if (matchesWebhookPath(pathname, '/linq')) return true;
  if (matchesWebhookPath(pathname, '/email/inbound')) return true;
  const bluebubblesPath = normalizeWebhookPath(
    env.BLUEBUBBLES_WEBHOOK_PATH || '/bluebubbles-webhook',
  );
  return matchesWebhookPath(pathname, bluebubblesPath);
}

export { Sandbox };

/**
 * Compute HMAC-SHA256 using Web Crypto API (available in Workers runtime).
 */
async function hmacSha256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Parse Bloo.io signature header format: "t=<unix_sec>,v1=<hex>"
 */
function parseBlooioSignature(header: string): { timestampSec: number | null; hmacHex: string | null } {
  const parts = header.split(',').map((p) => p.trim()).filter(Boolean);
  const tPart = parts.find((p) => p.startsWith('t='));
  const v1Part = parts.find((p) => p.startsWith('v1='));
  if (!tPart || !v1Part) return { timestampSec: null, hmacHex: null };
  const ts = Number(tPart.slice(2));
  return {
    timestampSec: Number.isFinite(ts) ? ts : null,
    hmacHex: v1Part.slice(3) || null,
  };
}

/**
 * Enrich a Bloo.io webhook payload by downloading attachments and base64-encoding them.
 * Assumes HMAC has already been verified by the caller.
 * Returns a new Request ready for containerFetch (with signature headers stripped).
 */
async function enrichBlooioPayload(rawText: string, originalUrl: string, originalHeaders: Headers): Promise<Request> {
  const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

  // Strip signature headers — Worker already verified HMAC
  const headers = new Headers(originalHeaders);
  headers.delete('x-bloo-signature');
  headers.delete('x-blooio-signature');

  const forwardOriginal = () =>
    new Request(originalUrl, { method: 'POST', headers, body: rawText });

  let body: any;
  try {
    body = JSON.parse(rawText);
  } catch (err: any) {
    console.error(`[BLOOIO] Failed to parse webhook JSON: ${err?.message || err}`);
    return forwardOriginal();
  }

  const attachments = body.attachments || body.body?.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) {
    console.log(`[BLOOIO] No attachments array in payload (keys: ${Object.keys(body).join(', ')})`);
    return forwardOriginal();
  }

  console.log(`[BLOOIO] Enriching ${attachments.length} attachment(s)`);

  for (let idx = 0; idx < attachments.length; idx++) {
    const att = attachments[idx];
    if (typeof att !== 'object' || att === null) {
      console.warn(`[BLOOIO] Attachment[${idx}] is not an object: ${typeof att} ${JSON.stringify(att)}`);
      continue;
    }
    const url = att.url || att.download_url || att.downloadUrl || att.signed_url || att.href;
    if (!url || typeof url !== 'string') {
      console.warn(`[BLOOIO] Attachment[${idx}] has no URL field (keys: ${Object.keys(att).join(', ')})`);
      continue;
    }
    try {
      console.log(`[BLOOIO] Attachment[${idx}] fetching: ${url}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) {
        const respBody = await resp.text().catch(() => '');
        console.error(`[BLOOIO] Attachment[${idx}] fetch failed: HTTP ${resp.status} ${resp.statusText} for ${url} — body: ${respBody.slice(0, 500)}`);
        continue;
      }
      const contentType = resp.headers.get('content-type') || 'application/octet-stream';
      const buf = await resp.arrayBuffer();
      console.log(`[BLOOIO] Attachment[${idx}] response: ${buf.byteLength} bytes, content-type: ${contentType}`);
      if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
        console.warn(`[BLOOIO] Attachment[${idx}] too large (${buf.byteLength} bytes), skipping: ${url}`);
        continue;
      }
      if (buf.byteLength === 0) {
        console.warn(`[BLOOIO] Attachment[${idx}] empty response body (0 bytes), skipping: ${url}`);
        continue;
      }
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      att.base64_data = btoa(binary);
      att.content_type = contentType;
      console.log(`[BLOOIO] Attachment[${idx}] enriched: ${url} (${buf.byteLength} bytes, ${contentType}, base64 length: ${att.base64_data.length})`);
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError';
      console.error(`[BLOOIO] Attachment[${idx}] download error for ${url}: ${isAbort ? 'TIMEOUT (30s)' : err?.message || err}`);
    }
  }

  const enriched = attachments.some((att: any) => att.base64_data);
  if (!enriched) {
    console.error(`[BLOOIO] No attachments were enriched out of ${attachments.length} — forwarding original payload`);
    return forwardOriginal();
  }
  console.log(`[BLOOIO] ${attachments.filter((a: any) => a.base64_data).length}/${attachments.length} attachment(s) enriched`);

  return new Request(originalUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}


/**
 * Validate required environment variables.
 * Returns an array of missing variable descriptions, or empty array if all are set.
 */
function validateRequiredEnv(env: MoltbotEnv): string[] {
  const missing: string[] = [];
  const isTestMode = env.DEV_MODE === 'true' || env.E2E_TEST_MODE === 'true';

  if (!env.MOLTBOT_GATEWAY_TOKEN) {
    missing.push('MOLTBOT_GATEWAY_TOKEN');
  }

  // CF Access vars not required in dev/test mode since auth is skipped
  if (!isTestMode) {
    if (!env.CF_ACCESS_TEAM_DOMAIN) {
      missing.push('CF_ACCESS_TEAM_DOMAIN');
    }

    if (!env.CF_ACCESS_AUD) {
      missing.push('CF_ACCESS_AUD');
    }
  }

  // AI provider: prefer Cloudflare AI Gateway, fall back to direct keys.
  // Not having an AI key should not block startup (webhooks, health checks, etc. still work).
  const hasCloudflareGateway = !!(
    env.CLOUDFLARE_AI_GATEWAY_API_KEY &&
    env.CF_AI_GATEWAY_ACCOUNT_ID &&
    env.CF_AI_GATEWAY_GATEWAY_ID
  );
  const hasLegacyGateway = !!(env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL);
  const hasAnthropicKey = !!env.ANTHROPIC_API_KEY;
  const hasOpenAIKey = !!env.OPENAI_API_KEY;

  if (!hasCloudflareGateway && !hasLegacyGateway && !hasAnthropicKey && !hasOpenAIKey) {
    console.warn('[CONFIG] No AI provider configured — AI features will be unavailable');
  }

  return missing;
}

/**
 * Build sandbox options based on environment configuration.
 *
 * SANDBOX_SLEEP_AFTER controls how long the container stays alive after inactivity:
 * - 'never' (default): Container stays alive indefinitely (recommended due to long cold starts)
 * - Duration string: e.g., '10m', '1h', '30s' - container sleeps after this period of inactivity
 *
 * To reduce costs at the expense of cold start latency, set SANDBOX_SLEEP_AFTER to a duration:
 *   npx wrangler secret put SANDBOX_SLEEP_AFTER
 *   # Enter: 10m (or 1h, 30m, etc.)
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';

  // 'never' means keep the container alive indefinitely
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }

  // Otherwise, use the specified duration
  return { sleepAfter };
}

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE: Applied to ALL routes
// =============================================================================

// Middleware: Log every request
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const redactedSearch = redactSensitiveParams(url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${redactedSearch}`);
  console.log(`[REQ] Has ANTHROPIC_API_KEY: ${!!c.env.ANTHROPIC_API_KEY}`);
  console.log(`[REQ] DEV_MODE: ${c.env.DEV_MODE}`);
  console.log(`[REQ] DEBUG_ROUTES: ${c.env.DEBUG_ROUTES}`);
  await next();
});

// Middleware: Initialize sandbox for all requests
app.use('*', async (c, next) => {
  const options = buildSandboxOptions(c.env);
  const sandbox = getSandbox(c.env.Sandbox, 'moltbot', options);
  c.set('sandbox', sandbox);
  await next();
});

// =============================================================================
// PUBLIC ROUTES: No Cloudflare Access authentication required
// =============================================================================

// Mount public routes first (before auth middleware)
// Includes: /sandbox-health, /logo.png, /logo-small.png, /api/status, /_admin/assets/*
app.route('/', publicRoutes);

// Mount CDP routes (uses shared secret auth via query param, not CF Access)
app.route('/cdp', cdp);

// =============================================================================
// PROTECTED ROUTES: Cloudflare Access authentication required
// =============================================================================

// Middleware: Validate required environment variables (skip in dev mode and for debug routes)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);

  // Skip validation for channel webhook paths (OpenClaw handles channel webhook auth)
  if (isPublicChannelWebhookPath(url.pathname, c.env)) {
    return next();
  }

  // Skip validation for debug routes (they have their own enable check)
  if (url.pathname.startsWith('/debug')) {
    return next();
  }

  // Skip validation in dev mode
  if (c.env.DEV_MODE === 'true') {
    return next();
  }

  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));

    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      // Return a user-friendly HTML error page
      const html = configErrorHtml.replace('{{MISSING_VARS}}', missingVars.join(', '));
      return c.html(html, 503);
    }

    // Return JSON error for API requests
    return c.json(
      {
        error: 'Configuration error',
        message: 'Required environment variables are not configured',
        missing: missingVars,
        hint: 'Set these using: wrangler secret put <VARIABLE_NAME>',
      },
      503,
    );
  }

  return next();
});

// Middleware: Cloudflare Access authentication for protected routes
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);

  // Skip auth for channel webhook paths (OpenClaw handles channel webhook auth)
  if (isPublicChannelWebhookPath(url.pathname, c.env)) {
    return next();
  }

  // Determine response type based on Accept header
  const acceptsHtml = c.req.header('Accept')?.includes('text/html');
  const middleware = createAccessMiddleware({
    type: acceptsHtml ? 'html' : 'json',
    redirectOnMissing: acceptsHtml,
  });

  return middleware(c, next);
});

// Mount API routes (protected by Cloudflare Access)
app.route('/api', api);

// Mount Admin UI routes (protected by Cloudflare Access)
app.route('/_admin', adminUi);

// Mount debug routes (protected by Cloudflare Access, only when DEBUG_ROUTES is enabled)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to Moltbot gateway
// =============================================================================

app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  let request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  // For browser requests (non-WebSocket, non-API), show loading page if gateway isn't ready
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

  // If the loading page sent us here with _ready=1, skip the loading page and wait for the gateway
  const isReadyRedirect = url.searchParams.has('_ready');

  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml && !isReadyRedirect) {
    console.log('[PROXY] Gateway not ready, serving loading page');

    // Start the gateway in the background (don't await)
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      }),
    );

    // Return the loading page immediately
    return c.html(loadingPageHtml);
  }

  // Ensure moltbot is running (this will wait for startup)
  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[PROXY] Failed to start Moltbot:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    let hint = 'Check worker logs with: wrangler tail';
    if (!c.env.ANTHROPIC_API_KEY) {
      hint = 'ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY';
    } else if (errorMessage.includes('heap out of memory') || errorMessage.includes('OOM')) {
      hint = 'Gateway ran out of memory. Try again or check for memory leaks.';
    }

    return c.json(
      {
        error: 'Moltbot gateway failed to start',
        details: errorMessage,
        hint,
      },
      503,
    );
  }

  // Proxy to Moltbot with WebSocket message interception
  if (isWebSocketRequest) {
    const debugLogs = c.env.DEBUG_ROUTES === 'true';
    const redactedSearch = redactSensitiveParams(url);

    console.log('[WS] Proxying WebSocket connection to Moltbot');
    if (debugLogs) {
      console.log('[WS] URL:', url.pathname + redactedSearch);
    }

    // Inject gateway token into WebSocket request if not already present.
    // CF Access redirects strip query params, so authenticated users lose ?token=.
    // Since the user already passed CF Access auth, we inject the token server-side.
    let wsRequest = request;
    if (c.env.MOLTBOT_GATEWAY_TOKEN && !url.searchParams.has('token')) {
      const tokenUrl = new URL(url.toString());
      tokenUrl.searchParams.set('token', c.env.MOLTBOT_GATEWAY_TOKEN);
      wsRequest = new Request(tokenUrl.toString(), request);
    }

    // Get WebSocket connection to the container
    const containerResponse = await sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
    console.log('[WS] wsConnect response status:', containerResponse.status);

    // Get the container-side WebSocket
    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      console.error('[WS] No WebSocket in container response - falling back to direct proxy');
      return containerResponse;
    }

    if (debugLogs) {
      console.log('[WS] Got container WebSocket, setting up interception');
    }

    // Create a WebSocket pair for the client
    const [clientWs, serverWs] = Object.values(new WebSocketPair());

    // Accept both WebSockets
    serverWs.accept();
    containerWs.accept();

    if (debugLogs) {
      console.log('[WS] Both WebSockets accepted');
      console.log('[WS] containerWs.readyState:', containerWs.readyState);
      console.log('[WS] serverWs.readyState:', serverWs.readyState);
    }

    // Relay messages from client to container
    serverWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Client -> Container:',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)',
        );
      }
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(event.data);
      } else if (debugLogs) {
        console.log('[WS] Container not open, readyState:', containerWs.readyState);
      }
    });

    // Relay messages from container to client, with error transformation
    containerWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Container -> Client (raw):',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)',
        );
      }
      let data = event.data;

      // Try to intercept and transform error messages
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (debugLogs) {
            console.log('[WS] Parsed JSON, has error.message:', !!parsed.error?.message);
          }
          if (parsed.error?.message) {
            if (debugLogs) {
              console.log('[WS] Original error.message:', parsed.error.message);
            }
            parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
            if (debugLogs) {
              console.log('[WS] Transformed error.message:', parsed.error.message);
            }
            data = JSON.stringify(parsed);
          }
        } catch (e) {
          if (debugLogs) {
            console.log('[WS] Not JSON or parse error:', e);
          }
        }
      }

      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      } else if (debugLogs) {
        console.log('[WS] Server not open, readyState:', serverWs.readyState);
      }
    });

    // Handle close events
    // Valid user-settable close codes: 1000 (normal) and 3000-4999
    const safeCloseCode = (code: number) =>
      code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;

    serverWs.addEventListener('close', (event) => {
      if (debugLogs) {
        console.log('[WS] Client closed:', event.code, event.reason);
      }
      containerWs.close(safeCloseCode(event.code), event.reason);
    });

    containerWs.addEventListener('close', (event) => {
      if (debugLogs) {
        console.log('[WS] Container closed:', event.code, event.reason);
      }
      // Transform the close reason (truncate to 123 bytes max for WebSocket spec)
      let reason = transformErrorMessage(event.reason, url.host);
      if (reason.length > 123) {
        reason = reason.slice(0, 120) + '...';
      }
      if (debugLogs) {
        console.log('[WS] Transformed close reason:', reason);
      }
      serverWs.close(safeCloseCode(event.code), reason);
    });

    // Handle errors
    serverWs.addEventListener('error', (event) => {
      console.error('[WS] Client error:', event);
      containerWs.close(1011, 'Client error');
    });

    containerWs.addEventListener('error', (event) => {
      console.error('[WS] Container error:', event);
      serverWs.close(1011, 'Container error');
    });

    if (debugLogs) {
      console.log('[WS] Returning intercepted WebSocket response');
    }
    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  }

  // Strip internal params before proxying to gateway
  if (url.searchParams.has('_ready')) {
    url.searchParams.delete('_ready');
    request = new Request(url.toString(), request);
  }

  // Enrich Bloo.io webhooks: verify HMAC and download attachments before proxying
  if (url.pathname === '/blooio/inbound' && request.method === 'POST') {
    const rawText = await request.text();

    // Verify HMAC signature if webhook secret is configured
    const webhookSecret = c.env.BLOOIO_WEBHOOK_SECRET;
    const signature =
      request.headers.get('x-bloo-signature') || request.headers.get('x-blooio-signature');
    if (webhookSecret && signature) {
      const SIGNATURE_MAX_AGE_SEC = 300;
      const { timestampSec, hmacHex } = parseBlooioSignature(signature);
      if (!timestampSec || !hmacHex) {
        console.error(`[BLOOIO] Malformed signature header: ${signature}`);
        return c.json({ error: 'Invalid signature' }, 401);
      }
      const expected = await hmacSha256(webhookSecret, `${timestampSec}.${rawText}`);
      if (expected.toLowerCase() !== hmacHex.toLowerCase()) {
        console.error(`[BLOOIO] HMAC mismatch — rejecting webhook`);
        return c.json({ error: 'Invalid signature' }, 401);
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - timestampSec) > SIGNATURE_MAX_AGE_SEC) {
        console.error(
          `[BLOOIO] Stale signature (age: ${Math.abs(nowSec - timestampSec)}s, max: ${SIGNATURE_MAX_AGE_SEC}s)`,
        );
        return c.json({ error: 'Stale signature' }, 401);
      }
      console.log(`[BLOOIO] HMAC verified`);
    }

    request = await enrichBlooioPayload(rawText, request.url, new Headers(request.headers));
  }

  console.log('[HTTP] Proxying:', url.pathname + url.search);
  const httpResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
  console.log('[HTTP] Response status:', httpResponse.status);

  // Add debug header to verify worker handled the request
  const newHeaders = new Headers(httpResponse.headers);
  newHeaders.set('X-Worker-Debug', 'proxy-to-moltbot');
  newHeaders.set('X-Debug-Path', url.pathname);

  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: newHeaders,
  });
});

/**
 * Scheduled handler for cron triggers.
 * Syncs moltbot config/state from container to R2 for persistence.
 */
async function scheduled(
  _event: ScheduledEvent,
  env: MoltbotEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  try {
    const options = buildSandboxOptions(env);
    const sandbox = getSandbox(env.Sandbox, 'moltbot', options);

    let gatewayProcess = await findExistingMoltbotProcess(sandbox);
    if (!gatewayProcess) {
      console.log('[cron] Gateway not running, starting it as safety net');
      await ensureMoltbotGateway(sandbox, env);
      gatewayProcess = await findExistingMoltbotProcess(sandbox);
      if (!gatewayProcess) {
        console.error('[cron] Gateway still not running after startup attempt');
        return;
      }
    }

    console.log('[cron] Starting backup sync to R2...');
    const result = await syncToR2(sandbox, env);

    if (result.success) {
      console.log('[cron] Backup sync completed successfully at', result.lastSync);
    } else {
      console.error('[cron] Backup sync failed:', result.error, result.details || '');
    }
  } catch (error) {
    console.error('[cron] Alarm handler failed:', error);
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
