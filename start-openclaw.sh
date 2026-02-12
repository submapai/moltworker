#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Restores config from R2 backup if available
# 2. Runs openclaw onboard --non-interactive to configure from env vars
# 3. Patches config for features onboard doesn't cover (channels, gateway auth)
# 4. Starts the gateway

set -e

if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running, exiting."
    exit 0
fi

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"

# ============================================================
# RESTORE FROM R2 BACKUP
# ============================================================
# R2 restore is handled by the worker via restoreFromR2() before
# this script runs. No s3fs mount or bash-level restore needed.

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    AUTH_ARGS=""
    if [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
        AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key \
            --cloudflare-ai-gateway-account-id $CF_AI_GATEWAY_ACCOUNT_ID \
            --cloudflare-ai-gateway-gateway-id $CF_AI_GATEWAY_GATEWAY_ID \
            --cloudflare-ai-gateway-api-key $CLOUDFLARE_AI_GATEWAY_API_KEY"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        AUTH_ARGS="--auth-choice apiKey --anthropic-api-key $ANTHROPIC_API_KEY"
    elif [ -n "$OPENAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key --openai-api-key $OPENAI_API_KEY"
    fi

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        $AUTH_ARGS \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-health

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, BlueBubbles, Bloo.io, Slack)
# - Gateway token auth
# - Trusted proxies for sandbox networking
# - Provider/base URL overrides
node << 'EOFPATCH'
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value) {
    return isPlainObject(value) ? value : {};
}

function parseCsvList(raw) {
    if (!raw) return [];
    return raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
const trustedProxies = parseCsvList(process.env.OPENCLAW_TRUSTED_PROXIES);
config.gateway.trustedProxies = trustedProxies.length > 0 ? trustedProxies : ['10.1.0.0'];

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// AI Gateway base URL override:
// ANTHROPIC_BASE_URL is picked up natively by the Anthropic SDK,
// so we don't need to patch the provider config. Writing a provider
// entry without a models array breaks OpenClaw's config validation.

// AI Gateway model override (CF_AI_GATEWAY_MODEL=provider/model-id)
// Adds a provider entry for any AI Gateway provider and sets it as default model.
// Examples:
//   workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
//   openai/gpt-4o
//   anthropic/claude-sonnet-4-5
if (process.env.CF_AI_GATEWAY_MODEL) {
    const raw = process.env.CF_AI_GATEWAY_MODEL.trim();
    const slashIdx = raw.indexOf('/');
    const hasValidSeparator = slashIdx > 0 && slashIdx < raw.length - 1;

    if (!hasValidSeparator) {
        console.warn(
            'CF_AI_GATEWAY_MODEL must be in provider/model-id format. Example: workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        );
    } else {
        const gwProvider = raw.substring(0, slashIdx).trim();
        const modelId = raw.substring(slashIdx + 1).trim();
        const providerPattern = /^[a-z0-9][a-z0-9-]*$/i;

        if (!providerPattern.test(gwProvider) || modelId.length === 0) {
            console.warn(
                `CF_AI_GATEWAY_MODEL contains an invalid provider or model id: "${raw}". Expected provider/model-id.`,
            );
        } else {
            const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
            const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
            const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

            let baseUrl;
            if (accountId && gatewayId) {
                baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
                if (gwProvider === 'workers-ai') baseUrl += '/v1';
            } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
                baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
            }

            if (baseUrl && apiKey) {
                const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
                const providerName = 'cf-ai-gw-' + gwProvider;

                config.models = config.models || {};
                config.models.providers = config.models.providers || {};
                config.models.providers[providerName] = {
                    baseUrl: baseUrl,
                    apiKey: apiKey,
                    api: api,
                    models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192 }],
                };
                config.agents = config.agents || {};
                config.agents.defaults = config.agents.defaults || {};
                config.agents.defaults.model = { primary: providerName + '/' + modelId };
                console.log('AI Gateway model override: provider=' + providerName + ' model=' + modelId + ' via ' + baseUrl);
            } else {
                console.warn('CF_AI_GATEWAY_MODEL set but missing required config (account ID, gateway ID, or API key)');
            }
        }
    }
}

// Telegram configuration
if (process.env.TELEGRAM_BOT_TOKEN) {
    const telegram = asObject(config.channels.telegram);
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || telegram.dmPolicy || 'pairing';

    telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
    telegram.enabled = true;
    telegram.dmPolicy = dmPolicy;

    const allowFrom = parseCsvList(process.env.TELEGRAM_DM_ALLOW_FROM);
    if (allowFrom.length > 0) {
        telegram.allowFrom = allowFrom;
    } else if (dmPolicy === 'open' && !Array.isArray(telegram.allowFrom)) {
        telegram.allowFrom = ['*'];
    }
    config.channels.telegram = telegram;
} else if (!config.channels.telegram) {
    config.channels.telegram = {
        enabled: false,
    };
}

// Discord configuration
// Discord uses a nested dm object: dm.policy, dm.allowFrom (per DiscordDmConfig)
if (process.env.DISCORD_BOT_TOKEN) {
    const discord = asObject(config.channels.discord);
    const dm = asObject(discord.dm);
    const dmPolicy = process.env.DISCORD_DM_POLICY || dm.policy || 'pairing';

    discord.token = process.env.DISCORD_BOT_TOKEN;
    discord.enabled = true;
    dm.policy = dmPolicy;
    if (dmPolicy === 'open' && !Array.isArray(dm.allowFrom)) {
        dm.allowFrom = ['*'];
    }
    discord.dm = dm;
    config.channels.discord = discord;
} else if (!config.channels.discord) {
    config.channels.discord = {
        enabled: false,
    };
}

// BlueBubbles configuration
if (process.env.BLUEBUBBLES_SERVER_URL && process.env.BLUEBUBBLES_PASSWORD) {
    const bluebubbles = asObject(config.channels.bluebubbles);

    bluebubbles.serverUrl = process.env.BLUEBUBBLES_SERVER_URL;
    bluebubbles.password = process.env.BLUEBUBBLES_PASSWORD;
    bluebubbles.enabled = true;

    if (process.env.BLUEBUBBLES_WEBHOOK_PATH) {
        const rawPath = process.env.BLUEBUBBLES_WEBHOOK_PATH.trim();
        if (rawPath.length > 0) {
            bluebubbles.webhookPath = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
        }
    }

    if (process.env.BLUEBUBBLES_DM_POLICY) {
        bluebubbles.dmPolicy = process.env.BLUEBUBBLES_DM_POLICY;
    }
    if (process.env.BLUEBUBBLES_GROUP_POLICY) {
        bluebubbles.groupPolicy = process.env.BLUEBUBBLES_GROUP_POLICY;
    }

    const dmAllowFrom = parseCsvList(process.env.BLUEBUBBLES_DM_ALLOW_FROM);
    const groupAllowFrom = parseCsvList(process.env.BLUEBUBBLES_GROUP_ALLOW_FROM);
    if (dmAllowFrom.length > 0) {
        bluebubbles.allowFrom = dmAllowFrom;
    }
    if (groupAllowFrom.length > 0) {
        bluebubbles.groupAllowFrom = groupAllowFrom;
    }

    if (process.env.BLUEBUBBLES_BLOCK_STREAMING) {
        bluebubbles.blockStreaming = process.env.BLUEBUBBLES_BLOCK_STREAMING.toLowerCase() === 'true';
    }

    config.channels.bluebubbles = bluebubbles;
} else if (!config.channels.bluebubbles) {
    config.channels.bluebubbles = {
        enabled: false,
    };
}

// Bloo.io channel configuration
const blooio = asObject(config.channels.blooio);
if (process.env.BLOOIO_API_KEY) {
    blooio.apiKey = process.env.BLOOIO_API_KEY;
}
if (blooio.enabled === undefined) {
    // Enabled by default; explicit false remains respected.
    blooio.enabled = true;
}
blooio.running = true;
blooio.outbound = true;
blooio.dmPolicy = 'pairing';
blooio.groupPolicy = 'allowlist';
blooio.session = asObject(blooio.session);
blooio.session.dmScope = 'per-channel-peer';

const dmAllowFrom = parseCsvList(process.env.BLOOIO_DM_ALLOW_FROM);
const groupAllowFrom = parseCsvList(process.env.BLOOIO_GROUP_ALLOW_FROM);
if (dmAllowFrom.length > 0) {
    blooio.allowFrom = dmAllowFrom;
}
if (groupAllowFrom.length > 0) {
    blooio.groupAllowFrom = groupAllowFrom;
}

config.channels.blooio = blooio;

// Bloo.io channel plugin registration
// load.paths entries are directories OpenClaw scans for plugin subdirectories,
// so we point to the parent — OpenClaw discovers the blooio plugin folder inside it.
const blooioPluginPath = '/root/.openclaw/plugins';
// plugins.entries keys are resolved by plugin ID (from openclaw.plugin.json),
// not npm package name.
const blooioPluginEntryKey = 'blooio';

config.plugins = asObject(config.plugins);
config.plugins.load = asObject(config.plugins.load);
config.plugins.load.paths = Array.isArray(config.plugins.load.paths) ? config.plugins.load.paths : [];
if (!config.plugins.load.paths.includes(blooioPluginPath)) {
    config.plugins.load.paths.push(blooioPluginPath);
}

config.plugins.entries = asObject(config.plugins.entries);
const blooioEntry = asObject(config.plugins.entries[blooioPluginEntryKey]);
if (blooioEntry.enabled === undefined) {
    blooioEntry.enabled = true;
}
config.plugins.entries[blooioPluginEntryKey] = blooioEntry;

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    const slack = asObject(config.channels.slack);
    slack.botToken = process.env.SLACK_BOT_TOKEN;
    slack.appToken = process.env.SLACK_APP_TOKEN;
    slack.enabled = true;
    config.channels.slack = slack;
} else if (!config.channels.slack) {
    config.channels.slack = {
        enabled: false,
    };
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

export OPENCLAW_EAGER_CHANNEL_OPTIONS=true
echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan --token "$OPENCLAW_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
fi
