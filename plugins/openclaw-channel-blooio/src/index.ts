const BLOOIO_API_BASE = 'https://backend.blooio.com/v2/api';

let pluginRuntime: any = null;

function getRuntime(): any {
  if (!pluginRuntime) throw new Error('Bloo.io plugin runtime not initialized');
  return pluginRuntime;
}

function getAccountConfig(cfg: any, accountId?: string) {
  const channelCfg = cfg?.channels?.blooio;
  if (!channelCfg) return null;

  if (accountId && channelCfg.accounts?.[accountId]) {
    return channelCfg.accounts[accountId];
  }

  if (channelCfg.accounts?.default) {
    return channelCfg.accounts.default;
  }

  return channelCfg;
}

/**
 * Handle an inbound Bloo.io message by dispatching through the
 * OpenClaw channel pipeline (routing → envelope → session → agent reply).
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
  const account = getAccountConfig(cfg, accountId);
  const apiKey = account?.apiKey;

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      responsePrefix: '',
      deliver: async (payload: any) => {
        const textToSend = payload.markdown || payload.text;
        if (!textToSend || !apiKey) return;

        try {
          const replyTarget = externalId.replace(/^(blooio|bloo|imessage):/i, '');
          const response = await fetch(
            `${BLOOIO_API_BASE}/chats/${encodeURIComponent(replyTarget)}/messages`,
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
            log?.info?.(`Bloo.io reply sent to ${replyTarget}`);
          }
        } catch (err: any) {
          log?.error?.(`Bloo.io send error: ${err.message}`);
        }
      },
    },
  });
}

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
    media: false,
    nativeCommands: false,
    blockStreaming: false,
    outbound: true,
  },

  reload: { configPrefixes: ['channels.blooio'] },

  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', title: 'Enabled', default: true },
      accounts: {
        type: 'object',
        title: 'Accounts',
        additionalProperties: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', title: 'Enabled', default: true },
            apiKey: { type: 'string', title: 'API Key', description: 'Bloo.io API key for sending messages' },
          },
          required: ['apiKey'],
        },
      },
      dmPolicy: {
        type: 'string',
        title: 'DM Policy',
        enum: ['open', 'pairing'],
        default: 'open',
        description: 'Who can send direct messages',
      },
      allowFrom: {
        type: 'array',
        title: 'Allow From',
        items: { type: 'string' },
        default: ['*'],
        description: 'List of allowed sender IDs (* for all)',
      },
    },
  },

  config: {
    listAccountIds: (cfg: any): string[] => {
      const channelCfg = cfg?.channels?.blooio;
      return channelCfg?.accounts && Object.keys(channelCfg.accounts).length > 0
        ? Object.keys(channelCfg.accounts)
        : ['default'];
    },

    resolveAccount: (cfg: any, accountId?: string) => {
      const channelCfg = cfg?.channels?.blooio;
      const id = accountId || 'default';
      const account = channelCfg?.accounts?.[id];
      return account
        ? { accountId: id, config: account, enabled: account.enabled !== false }
        : { accountId: 'default', config: channelCfg, enabled: channelCfg?.enabled !== false };
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
      approveHint: 'Use /allow blooio:<userId> to approve',
      normalizeEntry: (raw: string) => raw.replace(/^(blooio|bloo|imessage):/i, ''),
    }),
  },

  messaging: {
    normalizeTarget: ({ target }: any) =>
      target ? { targetId: target.replace(/^(blooio|bloo|imessage):/i, '') } : null,
    targetResolver: {
      looksLikeId: (id: string): boolean => /^[\w+\-.@]+$/.test(id),
      hint: '<phone-or-chat-id>',
    },
  },

  outbound: {
    deliveryMode: 'direct',

    resolveTarget: ({ to }: any) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return { ok: false, error: new Error('Requires --to <chatId>') };
      }
      return { ok: true, to: trimmed };
    },

    sendText: async ({ cfg, to, text, accountId, log }: any) => {
      const account = getAccountConfig(cfg, accountId);
      const apiKey = account?.apiKey;

      if (!apiKey) {
        log?.error?.('Bloo.io API key not configured');
        return { ok: false, error: 'BLOOIO_API_KEY not configured' };
      }

      const normalizedTo = to.replace(/^(blooio|bloo|imessage):/i, '');

      try {
        const response = await fetch(
          `${BLOOIO_API_BASE}/chats/${encodeURIComponent(normalizedTo)}/messages`,
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
        log?.info?.(`Bloo.io message sent to ${normalizedTo}`);
        return { ok: true, via: 'blooio', messageId: data?.id || '', data };
      } catch (err: any) {
        log?.error?.(`Bloo.io send error: ${err.message}`);
        return { ok: false, error: err.message };
      }
    },
  },

  gateway: {
    startAccount: async (ctx: any) => {
      // Bloo.io uses external webhooks forwarded by the moltworker,
      // so there's no long-lived connection to establish here.
      ctx.log?.info?.('Bloo.io channel account started (webhook-based, no persistent connection)');
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
      const account = getAccountConfig(cfg);
      return { ok: Boolean(account?.apiKey), details: {} };
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
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { external_id, text, message_id, timestamp, is_group, group_id, sender } = body;

        // Validate required fields are strings (not just truthy)
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

        const account = getAccountConfig(cfg, accountId);
        if (!account) {
          api.logger.warn('Bloo.io getAccountConfig returned null for account:', accountId);
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
