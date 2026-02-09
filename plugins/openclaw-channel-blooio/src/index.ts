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
  log?: any;
}): Promise<void> {
  const { cfg, accountId, externalId, text, messageId, timestamp, log } = opts;
  const rt = getRuntime();

  // 1. Route: determine which agent handles this conversation
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: 'blooio',
    accountId,
    peer: { kind: 'dm', id: externalId },
  });

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
    chatType: 'direct',
    sender: { name: externalId, id: externalId },
    envelope: envelopeOptions,
  });

  // 5. Finalize inbound context
  const to = `blooio:${externalId}`;
  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: text,
    CommandBody: text,
    From: to,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: 'direct',
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
          const response = await fetch(
            `${BLOOIO_API_BASE}/chats/${encodeURIComponent(externalId)}/messages`,
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
            log?.info?.(`Bloo.io reply sent to ${externalId}`);
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
    chatTypes: ['direct'],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: false,
    outbound: true,
  },

  reload: { configPrefixes: ['channels.blooio'] },

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
      target ? { targetId: target.replace(/^(blooio|bloo):/i, '') } : null,
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

      try {
        const response = await fetch(
          `${BLOOIO_API_BASE}/chats/${encodeURIComponent(to)}/messages`,
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
        log?.info?.(`Bloo.io message sent to ${to}`);
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

  // Register HTTP route for inbound webhook messages forwarded by the moltworker
  api.registerHttpRoute({
    method: 'POST',
    path: '/blooio/inbound',
    handler: async (req: any, res: any) => {
      try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { external_id, text, message_id, timestamp } = body;

        if (!external_id || !text) {
          res.status(400).json({ error: 'Missing external_id or text' });
          return;
        }

        const cfg = api.getConfig();
        const accountId = 'default';

        // Dispatch asynchronously so the webhook gets a fast response
        handleInboundMessage({
          cfg,
          accountId,
          externalId: external_id,
          text,
          messageId: message_id || '',
          timestamp: timestamp || new Date().toISOString(),
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
