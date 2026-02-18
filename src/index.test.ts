import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv } from './test-utils';

const mocks = vi.hoisted(() => ({
  createAccessMiddleware: vi.fn(),
  ensureMoltbotGateway: vi.fn(),
  findExistingMoltbotProcess: vi.fn(),
  getProcessListHealth: vi.fn(),
  syncToR2: vi.fn(),
  getSandbox: vi.fn(),
}));

vi.mock('./auth', () => ({
  createAccessMiddleware: mocks.createAccessMiddleware,
}));

vi.mock('./gateway', () => ({
  ensureMoltbotGateway: mocks.ensureMoltbotGateway,
  findExistingMoltbotProcess: mocks.findExistingMoltbotProcess,
  getProcessListHealth: mocks.getProcessListHealth,
  syncToR2: mocks.syncToR2,
}));

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: mocks.getSandbox,
  Sandbox: class Sandbox {},
}));

vi.mock('./assets/loading.html?raw', () => ({
  default: '<html>loading</html>',
}));

vi.mock('./assets/config-error.html?raw', () => ({
  default: '<html>config error</html>',
}));

import worker from './index';

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

describe('worker channel webhook routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findExistingMoltbotProcess.mockResolvedValue(null);
    mocks.ensureMoltbotGateway.mockResolvedValue({ status: 'running' });
    mocks.getProcessListHealth.mockReturnValue({ lastError: null, lastErrorAt: 0 });
    mocks.syncToR2.mockResolvedValue({ success: true, lastSync: new Date().toISOString() });
  });

  it('proxies /blooio/inbound via catch-all without CF Access middleware', async () => {
    const containerFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    mocks.getSandbox.mockReturnValue({
      containerFetch,
      wsConnect: vi.fn(),
    });

    const authMiddleware = vi.fn(async (c: any) => c.json({ error: 'Unauthorized' }, 401));
    mocks.createAccessMiddleware.mockReturnValue(authMiddleware);

    const req = new Request('https://example.com/blooio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'inbound_message' }),
    });
    const env = createMockEnv();
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);

    // Catch-all passes raw request to container and returns container's response
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.createAccessMiddleware).not.toHaveBeenCalled();
    expect(authMiddleware).not.toHaveBeenCalled();
    expect(mocks.ensureMoltbotGateway).toHaveBeenCalledOnce();
    expect(containerFetch).toHaveBeenCalledOnce();
    expect(containerFetch.mock.calls[0][0]).toBe(req);
    expect(containerFetch.mock.calls[0][1]).toBe(18789);
  });

  it('returns 503 when gateway fails for /blooio/inbound', async () => {
    const containerFetch = vi.fn();
    mocks.getSandbox.mockReturnValue({
      containerFetch,
      wsConnect: vi.fn(),
    });

    mocks.ensureMoltbotGateway.mockRejectedValue(new Error('container dead'));

    const req = new Request('https://example.com/blooio/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'inbound_message' }),
    });
    const env = createMockEnv();
    const res = await worker.fetch(req, env, createExecutionContext());

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'Moltbot gateway failed to start' });
    expect(mocks.ensureMoltbotGateway).toHaveBeenCalledOnce();
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('proxies /email/inbound without applying CF Access middleware', async () => {
    const containerFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    mocks.getSandbox.mockReturnValue({
      containerFetch,
      wsConnect: vi.fn(),
    });

    const authMiddleware = vi.fn(async (c: any) => c.json({ error: 'Unauthorized' }, 401));
    mocks.createAccessMiddleware.mockReturnValue(authMiddleware);

    const req = new Request('https://example.com/email/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'owner@example.com', text: 'test' }),
    });
    const env = createMockEnv();
    const res = await worker.fetch(req, env, createExecutionContext());

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.createAccessMiddleware).not.toHaveBeenCalled();
    expect(authMiddleware).not.toHaveBeenCalled();
    expect(containerFetch).toHaveBeenCalledWith(req, 18789);
    expect(mocks.ensureMoltbotGateway).toHaveBeenCalledOnce();
  });

  it('does not bypass validation for non-blooio lookalike paths', async () => {
    const containerFetch = vi.fn().mockResolvedValue(new Response('unexpected', { status: 200 }));
    mocks.getSandbox.mockReturnValue({
      containerFetch,
      wsConnect: vi.fn(),
    });

    const req = new Request('https://example.com/blooioevil/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'inbound_message' }),
    });
    const env = createMockEnv();
    const res = await worker.fetch(req, env, createExecutionContext());

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: 'Configuration error',
    });
    expect(containerFetch).not.toHaveBeenCalled();
    expect(mocks.ensureMoltbotGateway).not.toHaveBeenCalled();
  });

  it('does not bypass validation for non-email lookalike paths', async () => {
    const containerFetch = vi.fn().mockResolvedValue(new Response('unexpected', { status: 200 }));
    mocks.getSandbox.mockReturnValue({
      containerFetch,
      wsConnect: vi.fn(),
    });

    const req = new Request('https://example.com/emailing/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'owner@example.com', text: 'test' }),
    });
    const env = createMockEnv();
    const res = await worker.fetch(req, env, createExecutionContext());

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: 'Configuration error',
    });
    expect(containerFetch).not.toHaveBeenCalled();
    expect(mocks.ensureMoltbotGateway).not.toHaveBeenCalled();
  });

  it('proxies default BlueBubbles webhook path without applying CF Access middleware', async () => {
    const containerFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    mocks.getSandbox.mockReturnValue({
      containerFetch,
      wsConnect: vi.fn(),
    });

    const authMiddleware = vi.fn(async (c: any) => c.json({ error: 'Unauthorized' }, 401));
    mocks.createAccessMiddleware.mockReturnValue(authMiddleware);

    const req = new Request('https://example.com/bluebubbles-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'message' }),
    });
    const env = createMockEnv();
    const res = await worker.fetch(req, env, createExecutionContext());

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.createAccessMiddleware).not.toHaveBeenCalled();
    expect(authMiddleware).not.toHaveBeenCalled();
    expect(containerFetch).toHaveBeenCalledWith(req, 18789);
  });

  it('proxies custom BlueBubbles webhook path from env without applying CF Access middleware', async () => {
    const containerFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    mocks.getSandbox.mockReturnValue({
      containerFetch,
      wsConnect: vi.fn(),
    });

    const authMiddleware = vi.fn(async (c: any) => c.json({ error: 'Unauthorized' }, 401));
    mocks.createAccessMiddleware.mockReturnValue(authMiddleware);

    const req = new Request('https://example.com/hooks/bluebubbles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'message' }),
    });
    const env = createMockEnv({ BLUEBUBBLES_WEBHOOK_PATH: '/hooks/bluebubbles' });
    const res = await worker.fetch(req, env, createExecutionContext());

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.createAccessMiddleware).not.toHaveBeenCalled();
    expect(authMiddleware).not.toHaveBeenCalled();
    expect(containerFetch).toHaveBeenCalledWith(req, 18789);
  });
});
