import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess, getProcessListHealth, wakeContainer } from '../gateway';

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      const { lastError, lastErrorAt } = getProcessListHealth();
      if (lastError && Date.now() - lastErrorAt < 15000) {
        return c.json({ ok: false, status: 'busy', error: lastError });
      }

      // Wake the container VM so the next synchronous request can start the gateway.
      // Uses containerFetch (has auto-start) instead of ensureMoltbotGateway (90s timeout)
      // because waitUntil() is limited to 30s after the response is sent.
      console.log('[STATUS] No gateway process found, waking container');
      c.executionCtx.waitUntil(wakeContainer(c.get('sandbox')));
      return c.json({ ok: false, status: 'starting' });
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /assets/* - Serve static assets from ASSETS binding, fallback to gateway proxy
// Our ASSETS binding has admin UI assets; the OpenClaw gateway serves its own UI assets.
// Try ASSETS first, proxy to gateway if not found.
publicRoutes.get('/assets/*', async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  if (response.ok) {
    return response;
  }
  // Not in ASSETS binding — proxy to the OpenClaw gateway
  const sandbox = c.get('sandbox');
  return sandbox.containerFetch(c.req.raw, MOLTBOT_PORT);
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

export { publicRoutes };
