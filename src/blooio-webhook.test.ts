import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { initBlooioRuntime } from '../submodules/channels/blooio/src/runtime';
import { handleBlooioWebhookRequest } from '../submodules/channels/blooio/src/webhook';

function createRuntimeStub() {
  const recordInboundSession = vi.fn(async () => {});
  const finalizeInboundContext = vi.fn((ctx: any) => ctx);
  const saveMediaBuffer = vi.fn(async (_buffer: Buffer, contentType?: string) => {
    const mime = contentType || 'application/octet-stream';
    const ext = mime === 'application/pdf' ? '.pdf'
      : mime === 'image/png' ? '.png'
      : mime === 'image/jpeg' ? '.jpg'
      : '.bin';
    return {
      path: `/tmp/test-media${ext}`,
      contentType: mime,
    };
  });
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
        media: {
          saveMediaBuffer,
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
    saveMediaBuffer,
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

/**
 * Create a mock fetch that returns fake image data for media download tests.
 */
function createMockFetch() {
  const fakeImageData = Buffer.from('fake-image-data');
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    // Return fake image data for any URL (simulates successful download)
    const contentType = urlStr.endsWith('.pdf') ? 'application/pdf'
      : urlStr.endsWith('.png') ? 'image/png'
      : 'image/jpeg';
    return new Response(fakeImageData, {
      status: 200,
      headers: { 'Content-Type': contentType },
    });
  });
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
  saveMediaBuffer: ReturnType<typeof vi.fn>;
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
  // Wait for the async fire-and-forget handleInboundMessage (includes media download)
  await new Promise((resolve) => setTimeout(resolve, 100));

  return {
    handled,
    status,
    body: JSON.parse(responseBody || '{}') as Record<string, unknown>,
    logger,
    finalizeInboundContext: runtime.finalizeInboundContext,
    recordInboundSession: runtime.recordInboundSession,
    saveMediaBuffer: runtime.saveMediaBuffer,
  };
}

describe('blooio webhook', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Mock fetch globally for media download tests
    globalThis.fetch = createMockFetch() as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

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

  it('acks 202 even when Bloo.io configuration lookup throws', async () => {
    const result = await postInboundWebhook({
      getConfig: () => {
        throw new Error('schema validation failed');
      },
    });

    expect(result.handled).toBe(true);
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true });
    expect(result.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Bloo.io config load error: schema validation failed'),
    );
    expect(result.recordInboundSession).not.toHaveBeenCalled();
  });

  it('downloads attachments and sets MediaPaths on inbound context', async () => {
    const imageUrl = 'https://bucket.blooio.com/api-attachments/photo.jpg';
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
            url: imageUrl,
          },
        ],
      },
    });

    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true });
    expect(result.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        // MediaPaths should be set (local temp file)
        MediaPaths: expect.arrayContaining([expect.stringContaining('.jpg')]),
        MediaPath: expect.stringContaining('.jpg'),
        // MediaUrls should mirror saved local paths (BlueBubbles-style)
        MediaUrls: expect.arrayContaining([expect.stringContaining('.jpg')]),
        MediaUrl: expect.stringContaining('.jpg'),
        MediaTypes: ['image/jpeg'],
        MediaType: 'image/jpeg',
      }),
    );
    expect(result.saveMediaBuffer).toHaveBeenCalledTimes(1);
    expect(result.recordInboundSession).toHaveBeenCalledTimes(1);
  });

  it('accepts wrapped webhook payloads and extracts nested attachments', async () => {
    const pdfUrl = 'https://bucket.blooio.com/api-attachments/statement.pdf';
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
        MediaPaths: expect.arrayContaining([expect.stringContaining('.pdf')]),
        MediaUrls: expect.arrayContaining([expect.stringContaining('.pdf')]),
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
            url: 'https://bucket.blooio.com/api-attachments/image.png',
            mime_type: 'image/png',
          },
        ],
      },
    });

    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true });
    expect(result.recordInboundSession).toHaveBeenCalledTimes(1);
  });

  it('does not pass remote MediaUrls when download fails', async () => {
    // Override fetch to simulate download failure
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as any;

    const imageUrl = 'https://bucket.blooio.com/api-attachments/photo.jpg';
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
        message_id: 'msg-media-fallback',
        external_id: '+15712170004',
        timestamp: 1770836813397,
        text: 'Check this out',
        sender: '+15712170004',
        attachments: [{ url: imageUrl }],
      },
    });

    expect(result.status).toBe(202);
    const ctx = result.finalizeInboundContext.mock.calls[0]?.[0];
    // Should not pass remote URLs when download fails
    expect(ctx?.MediaUrls).toBeUndefined();
    expect(ctx?.MediaUrl).toBeUndefined();
    // Should also not have local media path fields when download fails
    expect(ctx?.MediaPaths).toBeUndefined();
    expect(ctx?.MediaPath).toBeUndefined();
    // If no local media was saved, media type fields should be omitted as well
    expect(ctx?.MediaTypes).toBeUndefined();
    expect(ctx?.MediaType).toBeUndefined();
    expect(result.recordInboundSession).toHaveBeenCalledTimes(1);
  });

  it('retries attachment download without auth when authenticated fetch fails', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (urlStr === 'https://bucket.blooio.com/api-attachments/photo.jpg') {
        if (authHeader) {
          return new Response('not found', { status: 404 });
        }
        return new Response(Buffer.from('fake-image-data'), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = fetchMock as any;

    const imageUrl = 'https://bucket.blooio.com/api-attachments/photo.jpg';
    const result = await postInboundWebhook({
      getConfig: () => ({
        channels: {
          blooio: {
            enabled: true,
            apiKey: 'blooio:test-api-key',
          },
        },
      }),
      payload: {
        event: 'message.received',
        message_id: 'msg-media-auth-retry',
        external_id: '+15712170005',
        timestamp: 1770836813397,
        text: 'Who is this?',
        sender: '+15712170005',
        attachments: [{ url: imageUrl }],
      },
    });

    const downloadCalls = fetchMock.mock.calls.filter((call) => {
      const target = call[0];
      const urlStr = typeof target === 'string' ? target : target instanceof URL ? target.toString() : target.url;
      return urlStr === imageUrl;
    });

    expect(downloadCalls).toHaveLength(2);
    expect(result.status).toBe(202);
    expect(result.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaPaths: expect.arrayContaining([expect.stringContaining('.jpg')]),
        MediaUrls: expect.arrayContaining([expect.stringContaining('.jpg')]),
      }),
    );
    expect(result.recordInboundSession).toHaveBeenCalledTimes(1);
  });

  it('downloads each attachment from webhook attachments array', async () => {
    const urls = [
      'https://bucket.blooio.com/api-attachments/photo-a.jpg',
      'https://bucket.blooio.com/api-attachments/photo-b.jpg',
    ];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urls.includes(urlStr)) {
        return new Response(Buffer.from(`data-${urlStr}`), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = fetchMock as any;

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
        message_id: 'msg-media-multi',
        external_id: '+15712170006',
        timestamp: 1770836813397,
        text: 'What is in these photos?',
        sender: '+15712170006',
        attachments: urls.map((url) => ({ url })),
      },
    });

    const downloadCalls = fetchMock.mock.calls.filter((call) => {
      const target = call[0];
      const urlStr = typeof target === 'string' ? target : target instanceof URL ? target.toString() : target.url;
      return urls.includes(urlStr);
    });
    expect(downloadCalls).toHaveLength(2);
    expect(result.saveMediaBuffer).toHaveBeenCalledTimes(2);

    const ctx = result.finalizeInboundContext.mock.calls[0]?.[0];
    expect(Array.isArray(ctx?.MediaPaths)).toBe(true);
    expect(ctx?.MediaPaths).toHaveLength(2);
    expect(ctx?.MediaPaths[0]).toContain('.jpg');
    expect(ctx?.MediaPaths[1]).toContain('.jpg');
    expect(ctx?.MediaUrls).toEqual(ctx?.MediaPaths);
  });
});
