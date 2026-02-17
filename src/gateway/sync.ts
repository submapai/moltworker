import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

/** File extensions to exclude from backup */
const EXCLUDED_EXTENSIONS = ['.lock', '.log', '.tmp', '.sample'];

/** Directory names to always exclude from sync */
const EXCLUDED_DIRS = ['.git', 'node_modules'];

/** Check if a file should be excluded from sync */
function shouldExclude(filePath: string): boolean {
  if (EXCLUDED_EXTENSIONS.some((ext) => filePath.endsWith(ext))) return true;
  // Exclude .bak files (e.g. session.jsonl.bak-1234-timestamp)
  if (/\.bak(?:[.-]|$)/.test(filePath)) return true;
  // Exclude directories like .git/ and node_modules/
  const parts = filePath.split('/');
  if (parts.some((p) => EXCLUDED_DIRS.includes(p))) return true;
  return false;
}

/** Session .jsonl files — large and not needed for gateway startup */
const SESSION_DIR_PATTERN = /\/agents\/[^/]+\/sessions\//;

function isSessionFile(relPath: string): boolean {
  return SESSION_DIR_PATTERN.test(relPath) && relPath.endsWith('.jsonl');
}

/**
 * Sync OpenClaw config and workspace from container to R2 for persistence.
 *
 * Uses the R2 bucket binding directly (no s3fs FUSE mount).
 *
 * Syncs three directories:
 * - Config: /root/.openclaw/ (or /root/.clawdbot/) → R2: openclaw/
 * - Workspace: /root/clawd/ → R2: workspace/ (excluding skills/)
 * - Skills: /root/clawd/skills/ → R2: skills/
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  const bucket = env.MOLTBOT_BUCKET;
  if (!bucket) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Determine which config directory exists
  let configDir = '/root/.openclaw';
  try {
    const checkNew = await sandbox.exists('/root/.openclaw/openclaw.json');
    if (!checkNew.exists) {
      const checkLegacy = await sandbox.exists('/root/.clawdbot/clawdbot.json');
      if (checkLegacy.exists) {
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

  const syncSteps = [
    { name: 'config', sourcePath: configDir, r2Prefix: 'openclaw/', excludeDirs: [] as string[] },
    {
      name: 'workspace',
      sourcePath: '/root/clawd',
      r2Prefix: 'workspace/',
      excludeDirs: ['skills'],
    },
    {
      name: 'skills',
      sourcePath: '/root/clawd/skills',
      r2Prefix: 'skills/',
      excludeDirs: [] as string[],
    },
  ];

  try {
    for (const step of syncSteps) {
      console.log(`[sync] Starting ${step.name} sync...`);

      let files;
      try {
        const result = await sandbox.listFiles(step.sourcePath, {
          recursive: true,
          includeHidden: true,
        });
        files = result.files;
      } catch {
        // Directory may not exist (e.g., skills/ on first run)
        console.log(`[sync] ${step.name}: source not found, skipping`);
        continue;
      }

      for (const file of files) {
        if (file.type !== 'file') continue;

        const relPath = file.absolutePath.slice(step.sourcePath.length + 1);
        if (shouldExclude(file.absolutePath)) continue;
        if (step.excludeDirs.some((dir) => relPath.startsWith(dir + '/'))) continue;

        const r2Key = step.r2Prefix + relPath;

        const readResult = await sandbox.readFile(file.absolutePath);
        if (!readResult.success) {
          console.error(`[sync] Failed to read ${file.absolutePath}`);
          continue;
        }

        if (readResult.isBinary && readResult.encoding === 'base64') {
          // Binary file: decode base64 and upload as ArrayBuffer
          const binaryStr = atob(readResult.content);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          await bucket.put(r2Key, bytes.buffer);
        } else {
          await bucket.put(r2Key, readResult.content);
        }
      }

      console.log(`[sync] ${step.name} sync completed`);
    }

    // Write sync timestamp
    const lastSync = new Date().toISOString();
    await bucket.put('.last-sync', lastSync);

    console.log('[sync] Backup completed successfully at', lastSync);
    return { success: true, lastSync };
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Restore OpenClaw config and workspace from R2 to the container.
 *
 * Uses the R2 bucket binding directly (no s3fs FUSE mount).
 *
 * Restores three prefixes:
 * - R2: openclaw/ → /root/.openclaw/
 * - R2: workspace/ → /root/clawd/
 * - R2: skills/ → /root/clawd/skills/
 */
export async function restoreFromR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
): Promise<SyncResult & { deferredKeys?: string[] }> {
  const bucket = env.MOLTBOT_BUCKET;
  if (!bucket) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Check if a backup exists
  const lastSyncObj = await bucket.get('.last-sync');
  if (!lastSyncObj) {
    console.log('[restore] No backup found in R2, skipping restore');
    return { success: true, details: 'No backup found' };
  }
  const lastSync = await lastSyncObj.text();

  const restoreSteps = [
    { r2Prefix: 'openclaw/', targetPath: '/root/.openclaw' },
    { r2Prefix: 'workspace/', targetPath: '/root/clawd' },
    { r2Prefix: 'skills/', targetPath: '/root/clawd/skills' },
  ];

  const deferredKeys: string[] = [];

  try {
    for (const step of restoreSteps) {
      console.log(`[restore] Restoring ${step.r2Prefix} to ${step.targetPath}...`);

      // List all objects with this prefix (with cursor pagination)
      let cursor: string | undefined;
      let objectCount = 0;

      do {
        const listResult = await bucket.list({
          prefix: step.r2Prefix,
          ...(cursor ? { cursor } : {}),
        });

        const BATCH_SIZE = 5;
        const objects = listResult.objects.filter(
          (obj) => obj.key.slice(step.r2Prefix.length).length > 0,
        );

        // Separate deferred (large session files) from immediate
        const immediate: typeof objects = [];
        for (const obj of objects) {
          const relPath = obj.key.slice(step.r2Prefix.length);
          if (shouldExclude(relPath)) continue;
          if (isSessionFile('/' + relPath)) {
            deferredKeys.push(obj.key);
          } else {
            immediate.push(obj);
          }
        }

        for (let i = 0; i < immediate.length; i += BATCH_SIZE) {
          const batch = immediate.slice(i, i + BATCH_SIZE);
          await Promise.all(
            batch.map(async (obj) => {
              const relPath = obj.key.slice(step.r2Prefix.length);
              const targetFile = `${step.targetPath}/${relPath}`;

              // Ensure parent directory exists
              const parentDir = targetFile.slice(0, targetFile.lastIndexOf('/'));
              await sandbox.mkdir(parentDir, { recursive: true });

              // Fetch the object content
              const r2Obj = await bucket.get(obj.key);
              if (!r2Obj) return;

              const content = await r2Obj.text();
              await sandbox.writeFile(targetFile, content);
              objectCount++;
            }),
          );
        }

        cursor = listResult.truncated ? (listResult as any).cursor : undefined;
      } while (cursor);

      console.log(`[restore] Restored ${objectCount} files to ${step.targetPath}`);
    }

    if (deferredKeys.length > 0) {
      console.log(`[restore] Deferred ${deferredKeys.length} session file(s) for background restore`);
    }
    console.log('[restore] Restore completed from backup at', lastSync);
    return { success: true, lastSync, deferredKeys };
  } catch (err) {
    return {
      success: false,
      error: 'Restore error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Restore deferred session files from R2 in the background.
 * Called after the gateway is already running.
 */
export async function restoreDeferredFiles(
  sandbox: Sandbox,
  env: MoltbotEnv,
  keys: string[],
): Promise<void> {
  const bucket = env.MOLTBOT_BUCKET;
  if (!bucket || keys.length === 0) return;

  console.log(`[restore] Background: restoring ${keys.length} deferred session file(s)`);
  const BATCH_SIZE = 3;

  // Map R2 keys back to target paths
  const prefixMap: Record<string, string> = {
    'openclaw/': '/root/.openclaw',
    'workspace/': '/root/clawd',
    'skills/': '/root/clawd/skills',
  };

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (key) => {
        // Find the matching prefix
        let targetPath = '';
        let relPath = '';
        for (const [prefix, target] of Object.entries(prefixMap)) {
          if (key.startsWith(prefix)) {
            targetPath = target;
            relPath = key.slice(prefix.length);
            break;
          }
        }
        if (!targetPath || !relPath) return;

        const targetFile = `${targetPath}/${relPath}`;
        const parentDir = targetFile.slice(0, targetFile.lastIndexOf('/'));

        try {
          await sandbox.mkdir(parentDir, { recursive: true });
          const r2Obj = await bucket.get(key);
          if (!r2Obj) return;
          const content = await r2Obj.text();
          await sandbox.writeFile(targetFile, content);
        } catch {
          console.warn(`[restore] Background: failed to restore ${key}`);
        }
      }),
    );
  }
  console.log('[restore] Background: deferred session restore complete');
}
