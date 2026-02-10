import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getBlooioRuntime, getBlooioConfig, getBlooioLogger } from './runtime.js';
import { BLOOIO_API_BASE, getChannelConfig, normalizeChatId } from './channel.js';

const SIGNATURE_MAX_AGE_SEC = 300;
const MAX_BODY_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Raw HTTP helpers
// ---------------------------------------------------------------------------

function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; value?: unknown; raw?: string; error?: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: { ok: boolean; value?: unknown; raw?: string; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'request body timeout' });
      req.destroy();
    }, timeoutMs);

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish({ ok: false, error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) {
          finish({ ok: false, error: 'empty payload' });
          return;
        }
        finish({ ok: true, value: JSON.parse(raw) as unknown, raw });
      } catch (err) {
        finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 webhook signature verification
// ---------------------------------------------------------------------------

function parseSignatureHeader(header: string): { timestampSec: number | null; signatures: string[] } {
  const parts = header.split(',').map((p) => p.trim()).filter(Boolean);
  const tPart = parts.find((p) => p.startsWith('t='));
  const sigParts = parts.filter((p) => p.startsWith('v1='));
  if (!tPart || sigParts.length === 0) return { timestampSec: null, signatures: [] };
  const ts = Number(tPart.slice(2));
  return { timestampSec: Number.isFinite(ts) ? ts : null, signatures: sigParts.map((p) => p.slice(3)) };
}

function verifySignature(signatureHeader: string, rawBody: string, secret: string): { valid: boolean; timestampSec: number | null } {
  const { timestampSec, signatures } = parseSignatureHeader(signatureHeader);
  if (!timestampSec || signatures.length === 0) return { valid: false, timestampSec: null };

  const expected = createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  for (const candidate of signatures) {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(candidate.toLowerCase(), 'hex');
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { valid: true, timestampSec };
    }
  }
  return { valid: false, timestampSec };
}

// ---------------------------------------------------------------------------
// Inbound message dispatch
// ---------------------------------------------------------------------------

async function handleInboundMessage(opts: {
  cfg: any;
  accountId: string;
  externalId: string;
  text: string;
  messageId: string;
  timestamp: string;
  isGroup?: boolean;
  groupId?: string | null;
  log?: any;
}): Promise<void> {
  const { cfg, accountId, externalId, text, messageId, timestamp, isGroup, groupId, log } = opts;
  const rt = getBlooioRuntime();

  const chatType = isGroup ? 'group' : 'direct';
  const peerId = isGroup && groupId ? groupId : externalId;

  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: 'blooio',
    accountId,
    peer: { kind: isGroup ? 'group' : 'dm', id: peerId },
  });

  log?.debug?.(`Bloo.io route resolved: agent=${route.agentId} session=${route.sessionKey} chatType=${chatType}`);

  const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions({ cfg });

  const body = rt.channel.reply.formatInboundEnvelope({
    channel: 'Bloo.io',
    from: externalId,
    timestamp,
    body: text,
    chatType,
    sender: { name: externalId, id: externalId },
    envelope: envelopeOptions,
  });

  const to = `blooio:${peerId}`;
  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: text,
    CommandBody: text,
    From: to,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    ConversationLabel: externalId,
    SenderName: externalId,
    SenderId: externalId,
    Provider: 'blooio',
    Surface: 'blooio',
    MessageSid: messageId,
    Timestamp: timestamp,
    OriginatingChannel: 'blooio',
    OriginatingTo: to,
  });

  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey || route.sessionKey,
    ctx,
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: 'blooio',
      to: externalId,
      accountId,
    },
    onRecordError: (err: any) => log?.error?.(`Failed to record inbound session: ${String(err)}`),
  });

  const channelCfg = getChannelConfig(cfg);
  const apiKey = channelCfg?.apiKey;

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      responsePrefix: '',
      deliver: async (payload: any) => {
        const textToSend = payload.markdown || payload.text;
        if (!textToSend || !apiKey) return;

        try {
          const chatId = normalizeChatId(externalId);
          const response = await fetch(
            `${BLOOIO_API_BASE}/chats/${encodeURIComponent(chatId)}/messages`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({ text: textToSend }),
            },
          );

          if (!response.ok) {
            const errorText = await response.text();
            log?.error?.(`Bloo.io send failed: ${response.status} ${errorText}`);
          } else {
            log?.info?.(`Bloo.io reply sent to ${chatId}`);
          }
        } catch (err: any) {
          log?.error?.(`Bloo.io send error: ${err.message}`);
        }
      },
    },
  });
}

// ---------------------------------------------------------------------------
// HTTP handler (registered via api.registerHttpHandler)
// ---------------------------------------------------------------------------

export async function handleBlooioWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/blooio/inbound') return false;

  const log = getBlooioLogger();

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end('Method Not Allowed');
    return true;
  }

  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    const status = body.error === 'payload too large' ? 413 : 400;
    sendJson(res, status, { error: body.error ?? 'invalid payload' });
    log?.warn?.(`Bloo.io webhook rejected: ${body.error ?? 'invalid payload'}`);
    return true;
  }

  const rawBody = body.raw ?? '';

  try {
    // HMAC signature verification
    const webhookSecret = process.env.BLOOIO_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers['x-blooio-signature'];
      if (!signature || typeof signature !== 'string') {
        sendJson(res, 401, { error: 'Missing signature' });
        return true;
      }
      const { valid, timestampSec } = verifySignature(signature, rawBody, webhookSecret);
      if (!valid) {
        sendJson(res, 401, { error: 'Invalid signature' });
        return true;
      }
      if (typeof timestampSec === 'number') {
        const nowSec = Math.floor(Date.now() / 1000);
        if (Math.abs(nowSec - timestampSec) > SIGNATURE_MAX_AGE_SEC) {
          sendJson(res, 401, { error: 'Stale signature' });
          return true;
        }
      }
    }

    const payload = (body.value && typeof body.value === 'object' ? body.value : {}) as Record<string, unknown>;
    const { external_id, text, message_id, timestamp, is_group, group_id, sender } = payload;

    if (typeof external_id !== 'string' || !external_id) {
      sendJson(res, 400, { error: 'external_id must be a non-empty string' });
      return true;
    }
    if (typeof text !== 'string' || !text) {
      sendJson(res, 400, { error: 'text must be a non-empty string' });
      return true;
    }

    const cfg = getBlooioConfig();
    const accountId = 'default';
    const resolvedSender =
      typeof sender === 'string' && sender.trim().length > 0 ? sender.trim() : external_id;

    let normalizedTimestamp = new Date().toISOString();
    if (typeof timestamp === 'number') {
      normalizedTimestamp = new Date(timestamp).toISOString();
    } else if (typeof timestamp === 'string' && timestamp) {
      const parsed = Date.parse(timestamp);
      normalizedTimestamp = Number.isNaN(parsed) ? timestamp : new Date(parsed).toISOString();
    }

    const channelCfg = getChannelConfig(cfg);
    if (!channelCfg) {
      log?.warn?.('Bloo.io channel config not found');
      sendJson(res, 503, { error: 'Bloo.io channel not configured' });
      return true;
    }

    // Dispatch asynchronously so the webhook gets a fast response
    handleInboundMessage({
      cfg,
      accountId,
      externalId: (is_group ? resolvedSender : external_id) || external_id,
      text,
      messageId: (message_id as string) || '',
      timestamp: normalizedTimestamp,
      isGroup: (is_group as boolean) || false,
      groupId: (group_id as string) || null,
      log,
    }).catch((err: any) => {
      log?.error?.(`Bloo.io inbound dispatch error: ${err.message}`);
    });

    sendJson(res, 202, { ok: true });
  } catch (err: any) {
    log?.error?.(`Bloo.io inbound handler error: ${err.message}`);
    sendJson(res, 500, { error: 'Internal error' });
  }

  return true;
}
