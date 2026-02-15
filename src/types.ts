import type { Sandbox } from '@cloudflare/sandbox';

/**
 * Environment bindings for the Moltbot Worker
 */
export interface MoltbotEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher; // Assets binding for admin UI static files
  MOLTBOT_BUCKET: R2Bucket; // R2 bucket for persistent storage
  // Cloudflare AI Gateway configuration (preferred)
  CF_AI_GATEWAY_ACCOUNT_ID?: string; // Cloudflare account ID for AI Gateway
  CF_AI_GATEWAY_GATEWAY_ID?: string; // AI Gateway ID
  CLOUDFLARE_AI_GATEWAY_API_KEY?: string; // API key for requests through the gateway
  CF_AI_GATEWAY_MODEL?: string; // Override model: "provider/model-id" e.g. "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  // Legacy AI Gateway configuration (still supported for backward compat)
  AI_GATEWAY_API_KEY?: string; // API key for the provider configured in AI Gateway
  AI_GATEWAY_BASE_URL?: string; // AI Gateway URL (e.g., https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic)
  // Direct provider configuration
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  MOLTBOT_GATEWAY_TOKEN?: string; // Gateway token (mapped to OPENCLAW_GATEWAY_TOKEN for container)
  DEV_MODE?: string; // Set to 'true' for local dev (skips CF Access auth + openclaw device pairing)
  E2E_TEST_MODE?: string; // Set to 'true' for E2E tests (skips CF Access auth but keeps device pairing)
  DEBUG_ROUTES?: string; // Set to 'true' to enable /debug/* routes
  SANDBOX_SLEEP_AFTER?: string; // How long before sandbox sleeps: 'never' (default), or duration like '10m', '1h'
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_DM_POLICY?: string;
  TELEGRAM_DM_ALLOW_FROM?: string; // Comma-separated Telegram DM allowlist
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DM_POLICY?: string;
  EMAIL_WEBHOOK_SECRET?: string; // HMAC secret for inbound email webhook verification
  EMAIL_OUTBOUND_WEBHOOK_SECRET?: string; // HMAC secret for outbound /email/send webhook calls
  EMAIL_OUTBOUND_WEBHOOK_URL?: string; // HTTPS endpoint for outbound email delivery (e.g. /email/send worker route)
  EMAIL_FROM_ADDRESS?: string; // Outbound sender address for channel replies
  EMAIL_MAILCHANNELS_ENABLED?: string; // Set to 'true' or 'false' for direct MailChannels fallback
  EMAIL_REQUIRE_WEBHOOK_SIGNATURE?: string; // Set to 'true' or 'false' to require inbound signature verification
  EMAIL_DM_POLICY?: string; // open | pairing | allowlist | disabled
  EMAIL_DM_ALLOW_FROM?: string; // Comma-separated inbound sender allowlist
  EMAIL_SUPPRESS_REPLY?: string; // Set to 'true' to suppress email replies from the agent
  EMAIL_SMS_ACK_ENABLED?: string; // Set to 'true' to send SMS receipt acknowledgements
  EMAIL_SMS_ACK_TO?: string; // Comma-separated SMS/E.164 targets for email receipt acknowledgements
  BLOOIO_API_KEY?: string; // Bloo.io Bearer API key for outbound messages
  BLOOIO_WEBHOOK_SECRET?: string; // HMAC secret for inbound webhook verification
  BLOOIO_OUTBOUND?: string; // Set to 'true' or 'false' to enable/disable outbound sending
  BLOOIO_DM_POLICY?: string; // open | pairing | allowlist | disabled
  BLOOIO_GROUP_POLICY?: string; // open | allowlist | disabled
  BLOOIO_DM_ALLOW_FROM?: string; // Comma-separated Bloo.io DM allowlist
  BLOOIO_GROUP_ALLOW_FROM?: string; // Comma-separated Bloo.io group allowlist
  LINQ_API_KEY?: string; // Linq Bearer API key
  LINQ_WEBHOOK_SECRET?: string; // HMAC secret for inbound webhook verification
  LINQ_FROM_PHONE?: string; // E.164 phone number for outbound
  BLUEBUBBLES_SERVER_URL?: string; // BlueBubbles REST API URL, e.g. http://192.168.1.100:1234
  BLUEBUBBLES_PASSWORD?: string; // BlueBubbles API password
  BLUEBUBBLES_WEBHOOK_PATH?: string; // Webhook path, default /bluebubbles-webhook
  BLUEBUBBLES_DM_POLICY?: string; // open | pairing | allowlist | disabled
  BLUEBUBBLES_DM_ALLOW_FROM?: string; // Comma-separated BlueBubbles DM allowlist
  BLUEBUBBLES_GROUP_POLICY?: string; // open | allowlist | disabled
  BLUEBUBBLES_GROUP_ALLOW_FROM?: string; // Comma-separated BlueBubbles group allowlist
  BLUEBUBBLES_BLOCK_STREAMING?: string; // Set to 'true' or 'false' for block streaming behavior
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  OPENCLAW_TRUSTED_PROXIES?: string; // Comma-separated trusted proxy CIDRs/IPs
  // Cloudflare Access configuration for admin routes
  CF_ACCESS_TEAM_DOMAIN?: string; // e.g., 'myteam.cloudflareaccess.com'
  CF_ACCESS_AUD?: string; // Application Audience (AUD) tag
  // R2 credentials for bucket mounting (set via wrangler secret)
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string; // Override bucket name (default: 'moltbot-data')
  CF_ACCOUNT_ID?: string; // Cloudflare account ID for R2 endpoint
  // Browser Rendering binding for CDP shim
  BROWSER?: Fetcher;
  CDP_SECRET?: string; // Shared secret for CDP endpoint authentication
  WORKER_URL?: string; // Public URL of the worker (for CDP endpoint)
}

/**
 * Authenticated user from Cloudflare Access
 */
export interface AccessUser {
  email: string;
  name?: string;
}

/**
 * Hono app environment type
 */
export type AppEnv = {
  Bindings: MoltbotEnv;
  Variables: {
    sandbox: Sandbox;
    accessUser?: AccessUser;
  };
};

/**
 * JWT payload from Cloudflare Access
 */
export interface JWTPayload {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  iss: string;
  name?: string;
  sub: string;
  type: string;
}
