import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { initBlooioRuntime } from '../submodules/channels/blooio/src/runtime';
import { handleBlooioWebhookRequest } from '../submodules/channels/blooio/src/webhook';

function createRuntimeStub() {
  return {
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
        recordInboundSession: vi.fn(async () => {}),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatInboundEnvelope: vi.fn(() => 'formatted inbound'),
        finalizeInboundContext: vi.fn((ctx: any) => ctx),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {}),
      },
    },
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
}> {
  const logger = createLogger();
  initBlooioRuntime({
    runtime: createRuntimeStub(),
    getConfig: opts.getConfig,
    logger,
  });

  const payload = opts.payload ?? {
    event: 'message.received',
    message_id: '6tEwCxqp00OQ15suoLF9Q',
    external_id: '+15712177495',
    protocol: 'imessage',
    timestamp: 1770836813397,
    internal_id: '+17867310089',
    is_group: false,
    text: 'Hey',
    sender: '+15712177495',
    received_at: 1770836811289,
  };

  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  (req as any).method = 'POST';
  (req as any).url = '/blooio/inbound';
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

  const handledPromise = handleBlooioWebhookRequest(req, res);
  req.end(JSON.stringify(payload));
  const handled = await handledPromise;

  return {
    handled,
    status,
    body: JSON.parse(responseBody || '{}') as Record<string, unknown>,
    logger,
  };
}

describe('blooio webhook', () => {
  it('accepts message.received payloads at /blooio/inbound', async () => {
    const result = await postInboundWebhook({
      getConfig: () => ({
        channels: {
          blooio: {
            enabled: true,
          },
        },
      }),
    });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true });
  });

  it('accepts inbound payloads even when channels.blooio is omitted', async () => {
    const result = await postInboundWebhook({
      getConfig: () => ({}),
    });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true });
  });

  it('returns 503 when Bloo.io configuration lookup throws', async () => {
    const result = await postInboundWebhook({
      getConfig: () => {
        throw new Error('schema validation failed');
      },
    });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'Bloo.io configuration unavailable' });
    expect(result.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Bloo.io config load error: schema validation failed'),
    );
  });
});
