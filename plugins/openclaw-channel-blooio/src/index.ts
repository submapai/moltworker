import { createHmac, timingSafeEqual } from 'node:crypto';

const BLOOIO_API_BASE = 'https://backend.blooio.com/v2/api';

/** Maximum allowed age (in seconds) for a webhook signature timestamp */
const SIGNATURE_MAX_AGE_SEC = 300;

let pluginRuntime: any = null;

function getRuntime(): any {
  if (!pluginRuntime) throw new Error('Bloo.io plugin runtime not initialized');
  return pluginRuntime;
}

function getChannelConfig(cfg: any) {
  return cfg?.channels?.blooio || null;
}

/**
 * Strip channel prefix from a target ID.
 * Bloo.io chat IDs are E.164 phone numbers (+15551234567),
 * email addresses, or group IDs (grp_xxxx).
 */
function normalizeChatId(raw: string): string {
  return raw.replace(/^blooio:/i, '');
}

/**
 * Handle an inbound Bloo.io message by dispatching through the
 * OpenClaw channel pipeline (routing -> envelope -> session -> agent reply).
 */
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
  const rt = getRuntime();

  const chatType = isGroup ? 'group' : 'direct';
  const peerId = isGroup && groupId ? groupId : externalId;

  // 1. Route: determine which agent handles this conversation
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: 'blooio',
    accountId,
    peer: { kind: isGroup ? 'group' : 'dm', id: peerId },
  });

  log?.debug?.(`Bloo.io route resolved: agent=${route.agentId} session=${route.sessionKey} chatType=${chatType}`);

  // 2. Resolve session store path
  const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  // 3. Resolve envelope format options
  const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions({ cfg });

  // 4. Format the inbound envelope
  const body = rt.channel.reply.formatInboundEnvelope({
    channel: 'Bloo.io',
    from: externalId,
    timestamp,
    body: text,
    chatType,
    sender: { name: externalId, id: externalId },
    envelope: envelopeOptions,
  });

  // 5. Finalize inbound context
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

  // 6. Record inbound session
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

  // 7. Dispatch reply — triggers agent run and delivers via outbound.sendText
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
// Channel definition — modeled after BlueBubbles (webhook-based channel)
// ---------------------------------------------------------------------------

const blooioChannel = {
  id: 'blooio',

  meta: {
    id: 'blooio',
    label: 'Bloo.io',
    selectionLabel: 'Bloo.io (iMessage/WhatsApp)',
    blurb: 'Bloo.io messaging channel for iMessage and WhatsApp',
    aliases: ['bloo', 'imessage'],
  },

  capabilities: {
    chatTypes: ['direct', 'group'],
    reactions: true,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
    outbound: true,
  },

  reload: { configPrefixes: ['channels.blooio'] },

  // Config schema mirrors BlueBubbles: flat with dm + group policies
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', title: 'Enabled', default: true },
      apiKey: { type: 'string', title: 'API Key', description: 'Bloo.io Bearer API key' },
      dmPolicy: {
        type: 'string',
        title: 'DM Policy',
        enum: ['open', 'pairing', 'allowlist', 'disabled'],
        default: 'open',
        description: 'Who can send direct messages',
      },
      groupPolicy: {
        type: 'string',
        title: 'Group Policy',
        enum: ['open', 'allowlist', 'disabled'],
        default: 'open',
        description: 'Who can interact in group chats',
      },
      allowFrom: {
        type: 'array',
        title: 'DM Allow From',
        items: { type: 'string' },
        default: ['*'],
        description: 'Allowed sender IDs for DMs (* for all). E.164 phone or email.',
      },
      groupAllowFrom: {
        type: 'array',
        title: 'Group Allow From',
        items: { type: 'string' },
        default: ['*'],
        description: 'Allowed sender IDs for groups (* for all)',
      },
      blockStreaming: {
        type: 'boolean',
        title: 'Block Streaming',
        default: false,
        description: 'Send complete response as single message instead of streaming chunks',
      },
      textChunkLimit: {
        type: 'number',
        title: 'Text Chunk Limit',
        default: 4000,
        description: 'Max characters per outbound message',
      },
    },
    required: ['apiKey'],
  },

  config: {
    listAccountIds: (): string[] => ['default'],

    resolveAccount: (cfg: any, accountId?: string) => {
      const channelCfg = cfg?.channels?.blooio;
      return {
        accountId: accountId || 'default',
        config: channelCfg,
        enabled: channelCfg?.enabled !== false,
      };
    },

    defaultAccountId: (): string => 'default',

    isConfigured: (account: any): boolean => {
      return Boolean(account.config?.apiKey);
    },

    describeAccount: (account: any) => ({
      accountId: account.accountId,
      name: 'Bloo.io',
      enabled: account.enabled,
      configured: Boolean(account.config?.apiKey),
    }),
  },

  security: {
    resolveDmPolicy: ({ account }: any) => ({
      policy: account.config?.dmPolicy || 'open',
      allowFrom: account.config?.allowFrom || ['*'],
      policyPath: 'channels.blooio.dmPolicy',
      allowFromPath: 'channels.blooio.allowFrom',
      approveHint: 'Use /allow blooio:<phone-or-email> to approve',
      normalizeEntry: (raw: string) => normalizeChatId(raw),
    }),
    resolveGroupPolicy: ({ account }: any) => ({
      policy: account.config?.groupPolicy || 'open',
      allowFrom: account.config?.groupAllowFrom || ['*'],
      policyPath: 'channels.blooio.groupPolicy',
      allowFromPath: 'channels.blooio.groupAllowFrom',
    }),
  },

  messaging: {
    // Chat IDs: E.164 phone (+15551234567), email, or group ID (grp_xxxx)
    normalizeTarget: ({ target }: any) =>
      target ? { targetId: normalizeChatId(target) } : null,
    targetResolver: {
      looksLikeId: (id: string): boolean => /^[+\w.\-@]+$/.test(id),
      hint: '<+phone | email | grp_xxxx>',
    },
  },

  outbound: {
    deliveryMode: 'direct',

    resolveTarget: ({ to }: any) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return { ok: false, error: new Error('Requires --to <+phone | email | grp_xxxx>') };
      }
      return { ok: true, to: trimmed };
    },

    sendText: async ({ cfg, to, text, log }: any) => {
      const channelCfg = getChannelConfig(cfg);
      const apiKey = channelCfg?.apiKey;

      if (!apiKey) {
        log?.error?.('Bloo.io API key not configured');
        return { ok: false, error: 'BLOOIO_API_KEY not configured' };
      }

      const chatId = normalizeChatId(to);

      try {
        const response = await fetch(
          `${BLOOIO_API_BASE}/chats/${encodeURIComponent(chatId)}/messages`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ text }),
          },
        );

        if (!response.ok) {
          const errorText = await response.text();
          log?.error?.(`Bloo.io send failed: ${response.status} ${errorText}`);
          return { ok: false, error: `HTTP ${response.status}: ${errorText}` };
        }

        const data = await response.json();
        log?.info?.(`Bloo.io message sent to ${chatId}`);
        return { ok: true, via: 'blooio', messageId: data?.message_id || '', data };
      } catch (err: any) {
        log?.error?.(`Bloo.io send error: ${err.message}`);
        return { ok: false, error: err.message };
      }
    },
  },

  gateway: {
    startAccount: async (ctx: any) => {
      // Bloo.io is webhook-based (like BlueBubbles) — no long-lived connection.
      // Inbound messages arrive via webhooks forwarded by the moltworker.
      ctx.log?.info?.('Bloo.io channel started (webhook-based, no persistent connection)');
      ctx.updateSnapshot?.({ running: true, lastStartAt: new Date().toISOString() });
      return { stop: () => {} };
    },
  },

  status: {
    defaultRuntime: {
      accountId: 'default',
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    probe: async ({ cfg }: any) => {
      const channelCfg = getChannelConfig(cfg);
      return { ok: Boolean(channelCfg?.apiKey), details: {} };
    },
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot?.configured ?? false,
      running: snapshot?.running ?? false,
      lastStartAt: snapshot?.lastStartAt ?? null,
      lastStopAt: snapshot?.lastStopAt ?? null,
      lastError: snapshot?.lastError ?? null,
    }),
  },
};

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export default function register(api: any) {
  pluginRuntime = api.runtime;
  api.logger.info('Bloo.io channel plugin loaded');
  api.registerChannel({ plugin: blooioChannel });

  const routePath = '/blooio/inbound';
  api.logger.info(`Bloo.io registering HTTP route: POST ${routePath}`);

  // Register HTTP route for inbound webhook messages forwarded by the moltworker
  api.registerHttpRoute({
    method: 'POST',
    path: routePath,
    handler: async (req: any, res: any) => {
      try {
        const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

        // HMAC signature verification
        const webhookSecret = process.env.BLOOIO_WEBHOOK_SECRET;
        if (webhookSecret) {
          const signature = req.headers?.['x-blooio-signature'];
          if (!signature) {
            res.status(401).json({ error: 'Missing signature' });
            return;
          }
          const { valid, timestampSec } = verifySignature(signature, rawBody, webhookSecret);
          if (!valid) {
            res.status(401).json({ error: 'Invalid signature' });
            return;
          }
          if (typeof timestampSec === 'number') {
            const nowSec = Math.floor(Date.now() / 1000);
            if (Math.abs(nowSec - timestampSec) > SIGNATURE_MAX_AGE_SEC) {
              res.status(401).json({ error: 'Stale signature' });
              return;
            }
          }
        }

        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { external_id, text, message_id, timestamp, is_group, group_id, sender } = body;

        if (typeof external_id !== 'string' || !external_id) {
          res.status(400).json({ error: 'external_id must be a non-empty string' });
          return;
        }
        if (typeof text !== 'string' || !text) {
          res.status(400).json({ error: 'text must be a non-empty string' });
          return;
        }

        const cfg = api.getConfig();
        const accountId = 'default';
        const resolvedSender =
          typeof sender === 'string' && sender.trim().length > 0 ? sender.trim() : external_id;

        let normalizedTimestamp = new Date().toISOString();
        if (typeof timestamp === 'number') {
          normalizedTimestamp = new Date(timestamp).toISOString();
        } else if (typeof timestamp === 'string' && timestamp) {
          const parsed = Date.parse(timestamp);
          normalizedTimestamp = Number.isNaN(parsed)
            ? timestamp
            : new Date(parsed).toISOString();
        }

        const channelCfg = getChannelConfig(cfg);
        if (!channelCfg) {
          api.logger.warn('Bloo.io channel config not found');
          res.status(503).json({ error: 'Bloo.io channel not configured' });
          return;
        }

        // Dispatch asynchronously so the webhook gets a fast response
        handleInboundMessage({
          cfg,
          accountId,
          externalId: (is_group ? resolvedSender : external_id) || external_id,
          text,
          messageId: message_id || '',
          timestamp: normalizedTimestamp,
          isGroup: is_group || false,
          groupId: group_id || null,
          log: api.logger,
        }).catch((err: any) => {
          api.logger.error(`Bloo.io inbound dispatch error: ${err.message}`);
        });

        res.status(202).json({ ok: true });
      } catch (err: any) {
        api.logger.error(`Bloo.io inbound handler error: ${err.message}`);
        res.status(500).json({ error: 'Internal error' });
      }
    },
  });
}
