import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

/**
 * Sync OpenClaw config and workspace from container to R2 for persistence.
 *
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Verifies source has critical files (prevents overwriting good backup with empty data)
 * 3. Runs rsync to copy config, workspace, and skills to R2
 * 4. Writes a timestamp file for tracking
 *
 * Syncs three directories:
 * - Config: /root/.openclaw/ (or /root/.clawdbot/) → R2:/openclaw/
 * - Workspace: /root/clawd/ → R2:/workspace/ (IDENTITY.md, MEMORY.md, memory/, assets/)
 * - Skills: /root/clawd/skills/ → R2:/skills/
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns SyncResult with success status and optional error details
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'Failed to mount R2 storage' };
  }

  // Determine which config directory exists
  // Check new path first, fall back to legacy
  // Use stdout parsing — exitCode may be null/undefined in the Cloudflare Sandbox API
  let configDir = '/root/.openclaw';
  try {
    const checkNew = await sandbox.startProcess(
      'test -f /root/.openclaw/openclaw.json && echo "ok"',
    );
    await waitForProcess(checkNew, 5000);
    const newLogs = await checkNew.getLogs();
    if (!newLogs.stdout?.includes('ok')) {
      const checkLegacy = await sandbox.startProcess(
        'test -f /root/.clawdbot/clawdbot.json && echo "ok"',
      );
      await waitForProcess(checkLegacy, 5000);
      const legacyLogs = await checkLegacy.getLogs();
      if (legacyLogs.stdout?.includes('ok')) {
        configDir = '/root/.clawdbot';
      } else {
        return {
          success: false,
          error: 'Sync aborted: no config file found',
          details: 'Neither openclaw.json nor clawdbot.json found in config directory.',
        };
      }
    }
  } catch (err) {
    return {
      success: false,
      error: 'Failed to verify source files',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Verify R2 mount is writable before attempting sync
  const writeCheck = await sandbox.startProcess(
    `touch ${R2_MOUNT_PATH}/.sync-check && rm -f ${R2_MOUNT_PATH}/.sync-check && echo "writable"`,
  );
  await waitForProcess(writeCheck, 10000);
  const writeCheckLogs = await writeCheck.getLogs();
  if (!writeCheckLogs.stdout?.includes('writable')) {
    return {
      success: false,
      error: 'R2 mount is not writable',
      details: `stdout: ${writeCheckLogs.stdout?.slice(0, 200) || '(empty)'}, stderr: ${writeCheckLogs.stderr?.slice(0, 200) || '(empty)'}`,
    };
  }

  // Ensure target directories exist on R2 mount
  const mkdirCmd = `mkdir -p ${R2_MOUNT_PATH}/openclaw ${R2_MOUNT_PATH}/workspace ${R2_MOUNT_PATH}/skills`;
  const mkdirProc = await sandbox.startProcess(mkdirCmd);
  await waitForProcess(mkdirProc, 5000);

  // Sync to the new openclaw/ R2 prefix (even if source is legacy .clawdbot)
  // Also sync workspace directory (excluding skills since they're synced separately)
  // Run each rsync separately to get better error reporting
  const syncSteps = [
    {
      name: 'config',
      cmd: `rsync -rv --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' ${configDir}/ ${R2_MOUNT_PATH}/openclaw/`,
    },
    {
      name: 'workspace',
      cmd: `rsync -rv --no-times --delete --exclude='skills' /root/clawd/ ${R2_MOUNT_PATH}/workspace/`,
    },
    {
      name: 'skills',
      cmd: `rsync -rv --no-times --delete /root/clawd/skills/ ${R2_MOUNT_PATH}/skills/`,
    },
  ];

  try {
    for (const step of syncSteps) {
      console.log(`[sync] Starting ${step.name} sync...`);
      const proc = await sandbox.startProcess(step.cmd);
      await waitForProcess(proc, 30000); // 30 second timeout per step
      const logs = await proc.getLogs();

      // Check for rsync errors in stderr
      if (logs.stderr && logs.stderr.trim().length > 0) {
        // rsync prints some info to stderr that isn't errors (e.g., "sending incremental file list")
        // Only treat it as a failure if the output contains actual error indicators
        const hasError = /error|failed|denied|refused|No such file/i.test(logs.stderr);
        if (hasError) {
          console.error(`[sync] ${step.name} rsync error:`, logs.stderr.slice(0, 500));
          return {
            success: false,
            error: `Sync failed during ${step.name}`,
            details: logs.stderr.slice(0, 500),
          };
        }
      }
      console.log(`[sync] ${step.name} sync completed`);
    }

    // Write sync timestamp
    const timestampCmd = `date -Iseconds > ${R2_MOUNT_PATH}/.last-sync`;
    const timestampWriteProc = await sandbox.startProcess(timestampCmd);
    await waitForProcess(timestampWriteProc, 5000);

    // Read back the timestamp to confirm
    const timestampProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync`);
    await waitForProcess(timestampProc, 5000);
    const timestampLogs = await timestampProc.getLogs();
    const lastSync = timestampLogs.stdout?.trim();

    if (lastSync && lastSync.match(/^\d{4}-\d{2}-\d{2}/)) {
      console.log('[sync] Backup completed successfully at', lastSync);
      return { success: true, lastSync };
    } else {
      return {
        success: false,
        error: 'Sync completed but timestamp verification failed',
        details: `timestamp stdout: ${timestampLogs.stdout?.slice(0, 100) || '(empty)'}`,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
