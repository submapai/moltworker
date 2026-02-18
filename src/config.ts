/**
 * Configuration constants for Moltbot Sandbox
 */

/** Port that the Moltbot gateway listens on inside the container */
export const MOLTBOT_PORT = 18789;

/** Maximum time to wait for Moltbot to start (90 seconds) */
export const STARTUP_TIMEOUT_MS = 90_000;

/** Max retries for gateway startup in webhook background processing */
export const WEBHOOK_GATEWAY_MAX_RETRIES = 2;

/** Delay between gateway startup retries (ms) */
export const WEBHOOK_GATEWAY_RETRY_DELAY_MS = 3_000;
