import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { ensureMoltbotGateway } from '../gateway';

/**
 * Bloo.io webhook event payload
 */
interface BlooioWebhookEvent {
  event: string;
  message_id: string;
  external_id: string;
  protocol: string;
  text: string;
  attachments?: unknown[];
  timestamp: string;
  internal_id: string;
  is_group: boolean;
  group_id?: string;
}

/** Maximum allowed age (in seconds) for a webhook signature timestamp */
const SIGNATURE_MAX_AGE_SEC = 300;

/**
 * Verify Bloo.io HMAC-SHA256 webhook signature.
 *
 * Header format: `t=<timestamp>,v1=<hex_signature>`
 * Signed payload: `<timestamp>.<raw_body>`
 *
 * Returns `{ valid, timestampSec }` so callers can perform replay-protection.
 */
async function verifySignature(
  signatureHeader: string,
  rawBody: string,
  secret: string,
): Promise<{ valid: boolean; timestampSec: number }> {
  const parts = signatureHeader.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const signaturePart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !signaturePart) return { valid: false, timestampSec: 0 };

  const timestamp = timestampPart.slice(2);
  const timestampSec = Number(timestamp);
  const expectedSig = signaturePart.slice(3);

  const payload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hexSig = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  if (hexSig.length !== expectedSig.length) return { valid: false, timestampSec };
  let result = 0;
  for (let i = 0; i < hexSig.length; i++) {
    result |= hexSig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  return { valid: result === 0, timestampSec };
}

/**
 * Dispatch an inbound Bloo.io message to the OpenClaw gateway's
 * Bloo.io channel plugin via its registered HTTP route.
 *
 * The plugin handles the full channel pipeline:
 * routing → envelope → session → agent reply → outbound delivery
 */
async function processBlooioMessage(
  sandbox: AppEnv['Variables']['sandbox'],
  env: AppEnv['Bindings'],
  event: BlooioWebhookEvent,
): Promise<void> {
  const gatewayToken = env.MOLTBOT_GATEWAY_TOKEN;

  // 1. Ensure gateway is running
  try {
    await ensureMoltbotGateway(sandbox, env);
  } catch (error) {
    console.error('[WEBHOOK] Failed to start gateway:', error);
    return;
  }

  // 2. Forward to the Bloo.io channel plugin's inbound HTTP route
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (gatewayToken) {
      headers['Authorization'] = `Bearer ${gatewayToken}`;
    }

    const dispatchResponse = await sandbox.containerFetch(
      new Request(`http://localhost:${MOLTBOT_PORT}/blooio/inbound`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          external_id: event.external_id,
          text: event.text,
          message_id: event.message_id,
          timestamp: event.timestamp,
          attachments: event.attachments || [],
          is_group: event.is_group || false,
          group_id: event.group_id || null,
          protocol: event.protocol || '',
        }),
      }),
      MOLTBOT_PORT,
    );

    if (!dispatchResponse.ok) {
      const errorText = await dispatchResponse.text();
      console.error(
        '[WEBHOOK] Plugin inbound dispatch failed:',
        dispatchResponse.status,
        errorText,
      );
    } else {
      console.log('[WEBHOOK] Message dispatched to Bloo.io channel plugin for', event.external_id);
    }
  } catch (error) {
    console.error('[WEBHOOK] Error dispatching to channel plugin:', error);
  }
}

/**
 * Webhook routes — public, no CF Access auth.
 * Secured via HMAC signature verification.
 */
const webhook = new Hono<AppEnv>();

webhook.post('/blooio', async (c) => {
  const rawBody = await c.req.text();

  // HMAC signature verification (if secret is configured)
  const webhookSecret = c.env.BLOOIO_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = c.req.header('X-Blooio-Signature');
    if (!signature) {
      console.error('[WEBHOOK] Missing X-Blooio-Signature header');
      return c.json({ error: 'Missing signature' }, 401);
    }

    const { valid, timestampSec } = await verifySignature(signature, rawBody, webhookSecret);
    if (!valid) {
      console.error('[WEBHOOK] Invalid webhook signature');
      return c.json({ error: 'Invalid signature' }, 401);
    }

    // Replay protection: reject signatures older than 5 minutes
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestampSec) > SIGNATURE_MAX_AGE_SEC) {
      console.error('[WEBHOOK] Stale signature, age:', Math.abs(nowSec - timestampSec), 'seconds');
      return c.json({ error: 'Stale signature' }, 401);
    }
  }

  let event: BlooioWebhookEvent;
  try {
    event = JSON.parse(rawBody) as BlooioWebhookEvent;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  console.log('[WEBHOOK] Received event:', event.event, 'from:', event.external_id);

  // Only process incoming messages
  if (event.event !== 'message.received') {
    return c.json({ ok: true });
  }

  // Ignore empty messages
  if (!event.text?.trim()) {
    return c.json({ ok: true });
  }

  const sandbox = c.get('sandbox');

  // Process asynchronously — return 200 immediately
  c.executionCtx.waitUntil(
    processBlooioMessage(sandbox, c.env, event).catch((error) => {
      console.error('[WEBHOOK] Unhandled error in async processing:', error);
    }),
  );

  return c.json({ ok: true });
});

export { webhook };
