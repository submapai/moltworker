import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { initBlooioRuntime } from '../submodules/channels/blooio/src/runtime';
import { handleBlooioWebhookRequest } from '../submodules/channels/blooio/src/webhook';

function createRuntimeStub() {
  const recordInboundSession = vi.fn(async () => {});
  const finalizeInboundContext = vi.fn((ctx: any) => ctx);
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
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {}),
        },
      },
    },
    recordInboundSession,
    finalizeInboundContext,
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
  finalizeInboundContext: ReturnType<typeof vi.fn>;
  recordInboundSession: ReturnType<typeof vi.fn>;
}> {
  const logger = createLogger();
  const runtime = createRuntimeStub();
  initBlooioRuntime({
    runtime: runtime.runtime,
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
  await new Promise((resolve) => setTimeout(resolve, 0));

  return {
    handled,
    status,
    body: JSON.parse(responseBody || '{}') as Record<string, unknown>,
    logger,
    finalizeInboundContext: runtime.finalizeInboundContext,
    recordInboundSession: runtime.recordInboundSession,
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

  it('passes attachment URLs and MIME types into inbound context', async () => {
    const imageUrl = 'https://cdn.example.com/uploads/photo.jpg';
    const result = await postInboundWebhook({
      getConfig: () => ({
        channels: {
          blooio: {
            enabled: true,
          },
        },
      }),
      payload: {
        event: 'message.received',
        message_id: 'msg-media-1',
        external_id: '+15712170001',
        timestamp: 1770836813397,
        text: 'Who is this?',
        sender: '+15712170001',
        attachments: [
          {
            id: 'att_1',
            url: imageUrl,
            mime_type: 'image/jpeg',
            file_name: 'photo.jpg',
          },
        ],
      },
    });

    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true });
    expect(result.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaUrls: [imageUrl],
        MediaUrl: imageUrl,
        MediaTypes: ['image/jpeg'],
        MediaType: 'image/jpeg',
      }),
    );
    expect(result.recordInboundSession).toHaveBeenCalledTimes(1);
  });

  it('accepts wrapped webhook payloads and extracts nested attachments', async () => {
    const pdfUrl = 'https://cdn.example.com/uploads/statement.pdf';
    const result = await postInboundWebhook({
      getConfig: () => ({
        channels: {
          blooio: {
            enabled: true,
          },
        },
      }),
      payload: {
        body: {
          event: 'message.received',
          message_id: 'msg-media-2',
          external_id: '+15712170002',
          timestamp: '1770836813397',
          sender: '+15712170002',
          text: 'Summarize this PDF',
          attachments: [
            {
              url: pdfUrl,
              mimeType: 'application/pdf',
            },
          ],
        },
      },
    });

    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true });
    expect(result.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaUrls: [pdfUrl],
        MediaTypes: ['application/pdf'],
      }),
    );
    expect(result.recordInboundSession).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit inbound events even when status is non-received', async () => {
    const result = await postInboundWebhook({
      getConfig: () => ({
        channels: {
          blooio: {
            enabled: true,
          },
        },
      }),
      payload: {
        event: 'message.received',
        status: 'sent',
        message_id: 'msg-media-3',
        external_id: '+15712170003',
        sender: '+15712170003',
        text: 'Who is this?',
        attachments: [
          {
            url: 'https://cdn.example.com/uploads/image-no-ext',
            mime_type: 'image/png',
          },
        ],
      },
    });

    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true });
    expect(result.recordInboundSession).toHaveBeenCalledTimes(1);
  });
});
