import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEmailRuntime } from '../submodules/channels/email/src/runtime';
import { handleEmailWebhookRequest } from '../submodules/channels/email/src/webhook';

function createRuntimeStub() {
  const recordInboundSession = vi.fn(async () => {});
  return {
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: 'agent-default',
            sessionKey: 'session-default',
            mainSessionKey: 'session-default',
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => '/tmp/sessions'),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatInboundEnvelope: vi.fn(() => 'formatted inbound'),
          finalizeInboundContext: vi.fn((ctx: any) => ctx),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {}),
        },
      },
    },
    recordInboundSession,
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

async function postInboundWebhook(opts: {
  getConfig: () => any;
  payload?: Record<string, unknown>;
}): Promise<{
  handled: boolean;
  status: number;
  body: Record<string, unknown>;
  logger: ReturnType<typeof createLogger>;
  recordInboundSession: ReturnType<typeof vi.fn>;
}> {
  const logger = createLogger();
  const runtime = createRuntimeStub();
  initEmailRuntime({
    runtime: runtime.runtime,
    getConfig: opts.getConfig,
    logger,
  });

  const payload = opts.payload ?? {
    from: 'owner@example.com',
    to: 'agent@submap.email',
    subject: 'Forwarded update',
    text: 'latest details',
    message_id: 'msg-1',
    timestamp: 1770836813397,
  };

  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  (req as any).method = 'POST';
  (req as any).url = '/email/inbound';
  (req as any).headers = { 'content-type': 'application/json' };

  let status = 200;
  let responseBody = '';
  const res = {
    writeHead: vi.fn((nextStatus: number) => {
      status = nextStatus;
      return res;
    }),
    end: vi.fn((chunk?: string | Buffer) => {
      if (typeof chunk === 'string') {
        responseBody += chunk;
      } else if (Buffer.isBuffer(chunk)) {
        responseBody += chunk.toString('utf8');
      }
      return res;
    }),
  } as unknown as ServerResponse;

  const handledPromise = handleEmailWebhookRequest(req, res);
  req.end(JSON.stringify(payload));
  const handled = await handledPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    handled,
    status,
    body: JSON.parse(responseBody || '{}') as Record<string, unknown>,
    logger,
    recordInboundSession: runtime.recordInboundSession,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('email webhook', () => {
  it('accepts allowlisted inbound emails', async () => {
    const result = await postInboundWebhook({
      getConfig: () => ({
        channels: {
          email: {
            enabled: true,
            fromAddress: 'agent@submap.email',
            requireWebhookSignature: false,
            dmPolicy: 'allowlist',
            allowFrom: ['owner@example.com'],
            suppressEmailReply: true,
          },
        },
      }),
    });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true });
    expect(result.recordInboundSession).toHaveBeenCalledTimes(1);
  });

  it('rejects non-allowlisted inbound emails', async () => {
    const result = await postInboundWebhook({
      getConfig: () => ({
        channels: {
          email: {
            enabled: true,
            fromAddress: 'agent@submap.email',
            requireWebhookSignature: false,
            dmPolicy: 'allowlist',
            allowFrom: ['owner@example.com'],
          },
        },
      }),
      payload: {
        from: 'intruder@example.com',
        to: 'agent@submap.email',
        subject: 'Forwarded update',
        text: 'latest details',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'Sender not allowed' });
    expect(result.recordInboundSession).not.toHaveBeenCalled();
  });

  it('sends SMS acknowledgement when enabled', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await postInboundWebhook({
      getConfig: () => ({
        channels: {
          blooio: {
            apiKey: 'bloo-key',
          },
          email: {
            enabled: true,
            fromAddress: 'agent@submap.email',
            requireWebhookSignature: false,
            dmPolicy: 'allowlist',
            allowFrom: ['owner@example.com'],
            suppressEmailReply: true,
            smsAckEnabled: true,
            smsAckTo: ['+15550001111'],
          },
        },
      }),
      payload: {
        from: 'owner@example.com',
        to: 'agent@submap.email',
        subject: 'Receipt please',
        text: 'latest details',
        message_id: 'msg-sms-ack',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.blooio.com/v2/api/chats/%2B15550001111/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer bloo-key',
        }),
      }),
    );
  });
});
