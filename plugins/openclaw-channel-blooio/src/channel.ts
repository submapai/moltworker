import { getBlooioRuntime } from './runtime.js';

export const BLOOIO_API_BASE = 'https://backend.blooio.com/v2/api';

export function getChannelConfig(cfg: any) {
  return cfg?.channels?.blooio || null;
}

export function normalizeChatId(raw: string): string {
  return raw.replace(/^blooio:/i, '');
}

export const blooioChannel = {
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
    normalizeTarget: ({ target }: any) =>
      target ? { targetId: normalizeChatId(target) } : null,
    targetResolver: {
      looksLikeId: (id: string): boolean => /^[+\w.\-@]+$/.test(id),
      hint: '<+phone | email | grp_xxxx>',
    },
  },

  outbound: {
    deliveryMode: 'direct',
    textChunkLimit: 4000,

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
        return { ok: true, channel: 'blooio', via: 'blooio', messageId: data?.message_id || '', data };
      } catch (err: any) {
        log?.error?.(`Bloo.io send error: ${err.message}`);
        return { ok: false, error: err.message };
      }
    },
  },

  gateway: {
    startAccount: async (ctx: any) => {
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
