import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { ensureMoltbotGateway } from '../gateway';

const BLOOIO_API_BASE = 'https://backend.blooio.com/v2/api';

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

/**
 * Verify Bloo.io HMAC-SHA256 webhook signature.
 *
 * Header format: `t=<timestamp>,v1=<hex_signature>`
 * Signed payload: `<timestamp>.<raw_body>`
 */
async function verifySignature(
  signatureHeader: string,
  rawBody: string,
  secret: string,
): Promise<boolean> {
  const parts = signatureHeader.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const signaturePart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !signaturePart) return false;

  const timestamp = timestampPart.slice(2);
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
  if (hexSig.length !== expectedSig.length) return false;
  let result = 0;
  for (let i = 0; i < hexSig.length; i++) {
    result |= hexSig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Process an incoming Bloo.io message asynchronously.
 *
 * 1. Ensure the OpenClaw gateway is running
 * 2. Forward the message to the gateway via /v1/chat/completions
 * 3. Send the AI response back via Bloo.io API
 */
async function processBlooioMessage(
  sandbox: AppEnv['Variables']['sandbox'],
  env: AppEnv['Bindings'],
  event: BlooioWebhookEvent,
): Promise<void> {
  const gatewayToken = env.MOLTBOT_GATEWAY_TOKEN;
  const blooioApiKey = env.BLOOIO_API_KEY;

  if (!blooioApiKey) {
    console.error('[WEBHOOK] BLOOIO_API_KEY not configured, cannot send reply');
    return;
  }

  // 1. Ensure gateway is running
  try {
    await ensureMoltbotGateway(sandbox, env);
  } catch (error) {
    console.error('[WEBHOOK] Failed to start gateway:', error);
    return;
  }

  // 2. Forward to OpenClaw gateway
  let aiResponse: string;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-openclaw-message-channel': 'blooio',
    };
    if (gatewayToken) {
      headers['Authorization'] = `Bearer ${gatewayToken}`;
    }

    const completionResponse = await sandbox.containerFetch(
      new Request(`http://localhost:${MOLTBOT_PORT}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: [{ role: 'user', content: event.text }],
          user: event.external_id,
        }),
      }),
      MOLTBOT_PORT,
    );

    if (!completionResponse.ok) {
      const errorText = await completionResponse.text();
      console.error(
        '[WEBHOOK] Gateway returned error:',
        completionResponse.status,
        errorText,
      );
      return;
    }

    const completion = (await completionResponse.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    aiResponse = completion.choices?.[0]?.message?.content || '';
    if (!aiResponse) {
      console.error('[WEBHOOK] Empty response from gateway');
      return;
    }
  } catch (error) {
    console.error('[WEBHOOK] Error calling gateway:', error);
    return;
  }

  // 3. Send reply via Bloo.io API
  try {
    const sendResponse = await fetch(
      `${BLOOIO_API_BASE}/chats/${encodeURIComponent(event.external_id)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${blooioApiKey}`,
        },
        body: JSON.stringify({ text: aiResponse }),
      },
    );

    if (!sendResponse.ok) {
      const errorText = await sendResponse.text();
      console.error('[WEBHOOK] Bloo.io send failed:', sendResponse.status, errorText);
    } else {
      console.log('[WEBHOOK] Reply sent to', event.external_id);
    }
  } catch (error) {
    console.error('[WEBHOOK] Error sending reply:', error);
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

    const valid = await verifySignature(signature, rawBody, webhookSecret);
    if (!valid) {
      console.error('[WEBHOOK] Invalid webhook signature');
      return c.json({ error: 'Invalid signature' }, 401);
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
