import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { restoreFromR2 } from './sync';

const PROCESS_LIST_TTL_MS = 3000;
const PROCESS_LIST_STALE_MS = 15000;
const START_THROTTLE_MS = 15000;

let cachedProcesses: Process[] | null = null;
let cachedAt = 0;
let listInFlight: Promise<Process[]> | null = null;
let lastListError: string | null = null;
let lastListErrorAt = 0;

let startInFlight: Promise<Process> | null = null;
let lastStartAttemptAt = 0;

async function listProcessesCached(sandbox: Sandbox): Promise<Process[]> {
  const now = Date.now();
  if (cachedProcesses && now - cachedAt < PROCESS_LIST_TTL_MS) {
    return cachedProcesses;
  }

  if (listInFlight) {
    return listInFlight;
  }

  listInFlight = sandbox
    .listProcesses()
    .then((processes) => {
      cachedProcesses = processes;
      cachedAt = Date.now();
      lastListError = null;
      lastListErrorAt = 0;
      return processes;
    })
    .catch((err) => {
      lastListError = err instanceof Error ? err.message : String(err);
      lastListErrorAt = Date.now();
      if (cachedProcesses && now - cachedAt < PROCESS_LIST_STALE_MS) {
        return cachedProcesses;
      }
      throw err;
    })
    .finally(() => {
      listInFlight = null;
    });

  return listInFlight;
}

export function getProcessListHealth(): { lastError: string | null; lastErrorAt: number } {
  return { lastError: lastListError, lastErrorAt: lastListErrorAt };
}

/** Reset cached process list (for tests) */
export function resetProcessCache(): void {
  cachedProcesses = null;
  cachedAt = 0;
  listInFlight = null;
}

/**
 * Find an existing OpenClaw gateway process.
 *
 * Also kills zombie processes (dead CLI/gateway processes) to prevent
 * accumulation that degrades listProcesses performance.
 *
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  let processes: Process[];
  try {
    processes = await listProcessesCached(sandbox);
  } catch (e) {
    console.log('Could not list processes:', e);
    return null;
  }

  let gatewayProcess: Process | null = null;
  const zombiesToKill: Process[] = [];

  for (const proc of processes) {
    const isGatewayProcess =
      proc.command.includes('start-openclaw.sh') ||
      proc.command.includes('openclaw gateway') ||
      // Legacy: match old startup script during transition
      proc.command.includes('start-moltbot.sh') ||
      proc.command.includes('clawdbot gateway');
    const isCliCommand =
      proc.command.includes('openclaw devices') ||
      proc.command.includes('openclaw --version') ||
      proc.command.includes('openclaw onboard') ||
      proc.command.includes('clawdbot devices') ||
      proc.command.includes('clawdbot --version');

    if (isGatewayProcess && !isCliCommand) {
      if ((proc.status === 'starting' || proc.status === 'running') && !gatewayProcess) {
        gatewayProcess = proc;
      } else {
        // Duplicate or dead gateway — schedule for cleanup
        zombiesToKill.push(proc);
      }
    } else if (isCliCommand && proc.status !== 'running' && proc.status !== 'starting') {
      // Dead CLI process — schedule for cleanup
      zombiesToKill.push(proc);
    }
  }

  // Clean up zombies to prevent accumulation
  if (zombiesToKill.length > 0) {
    console.log(`[Process] Cleaning up ${zombiesToKill.length} zombie process(es)`);
    for (const zombie of zombiesToKill) {
      try {
        await zombie.kill();
      } catch {
        // Already dead or can't be killed — ignore
      }
    }
    // Invalidate cache since we just killed processes
    cachedProcesses = null;
    cachedAt = 0;
  }

  return gatewayProcess;
}

/**
 * Ensure the OpenClaw gateway is running
 *
 * This will:
 * 1. Check for an existing gateway process (fast path — no R2 I/O)
 * 2. If none found, restore from R2 and start a new one
 * 3. Wait for it to be ready
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  if (startInFlight) {
    return startInFlight;
  }

  // Check if gateway is already running or starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log(
      'Found existing gateway process:',
      existingProcess.id,
      'status:',
      existingProcess.status,
    );

    // Always use full startup timeout - a process can be "running" but not ready yet
    // (e.g., just started by another concurrent request). Using a shorter timeout
    // causes race conditions where we kill processes that are still initializing.
    try {
      console.log('Waiting for gateway on port', MOLTBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('Gateway is reachable');
      return existingProcess;
      // eslint-disable-next-line no-unused-vars
    } catch (_e) {
      // Timeout waiting for port - process is likely dead or stuck, kill and restart
      console.log('Existing process not reachable after full timeout, killing and restarting...');
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('Failed to kill process:', killError);
      }
    }
  }

  const now = Date.now();
  if (now - lastStartAttemptAt < START_THROTTLE_MS) {
    throw new Error('Gateway start throttled (recent start attempt)');
  }
  lastStartAttemptAt = now;

  // Start a new OpenClaw gateway
  startInFlight = (async () => {
    console.log('Starting new OpenClaw gateway...');

    // Restore data from R2 before starting the gateway (skip if config already exists)
    try {
      const [hasNew, hasLegacy] = await Promise.all([
        sandbox.exists('/root/.openclaw/openclaw.json'),
        sandbox.exists('/root/.clawdbot/clawdbot.json'),
      ]);
      if (!hasNew.exists && !hasLegacy.exists) {
        const restoreResult = await restoreFromR2(sandbox, env);
        if (restoreResult.success && restoreResult.lastSync) {
          console.log('[Gateway] Restored from R2 backup at', restoreResult.lastSync);
        } else if (restoreResult.error) {
          console.log('[Gateway] R2 restore skipped:', restoreResult.error);
        }
      } else {
        console.log('[Gateway] Local config present; skipping R2 restore');
      }
    } catch (restoreErr) {
      console.log('[Gateway] R2 restore check failed:', restoreErr);
    }

    const envVars = buildEnvVars(env);
    const command = '/usr/local/bin/start-openclaw.sh';

    console.log('Starting process with command:', command);
    console.log('Environment vars being passed:', Object.keys(envVars));

    let process: Process;
    try {
      process = await sandbox.startProcess(command, {
        env: Object.keys(envVars).length > 0 ? envVars : undefined,
      });
      console.log('Process started with id:', process.id, 'status:', process.status);
    } catch (startErr) {
      console.error('Failed to start process:', startErr);
      throw startErr;
    }

    // Wait for the gateway to be ready
    try {
      console.log('[Gateway] Waiting for OpenClaw gateway to be ready on port', MOLTBOT_PORT);
      await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('[Gateway] OpenClaw gateway is ready!');

      const logs = await process.getLogs();
      if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
      if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
    } catch (e) {
      console.error('[Gateway] waitForPort failed:', e);
      // Kill the failed process to prevent zombie accumulation
      try {
        await process.kill();
      } catch {
        // Ignore kill errors
      }
      try {
        const logs = await process.getLogs();
        console.error('[Gateway] startup failed. Stderr:', logs.stderr);
        console.error('[Gateway] startup failed. Stdout:', logs.stdout);
        throw new Error(`OpenClaw gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`, {
          cause: e,
        });
      } catch (logErr) {
        if (logErr instanceof Error && logErr.message.startsWith('OpenClaw gateway failed')) {
          throw logErr;
        }
        console.error('[Gateway] Failed to get logs:', logErr);
        throw e;
      }
    }

    // Verify gateway is actually responding
    console.log('[Gateway] Verifying gateway health...');

    return process;
  })();

  try {
    return await startInFlight;
  } finally {
    startInFlight = null;
  }
}
