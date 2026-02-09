import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, getR2BucketName } from '../config';

/**
 * Check if R2 is already mounted by looking at the mount table
 */
async function isR2Mounted(sandbox: Sandbox): Promise<boolean> {
  try {
    const proc = await sandbox.startProcess(`mount | grep "s3fs on ${R2_MOUNT_PATH}"`);
    // Wait for the command to complete
    let attempts = 0;
    while (proc.status === 'running' && attempts < 10) {
      // eslint-disable-next-line no-await-in-loop -- intentional sequential polling
      await new Promise((r) => setTimeout(r, 200));
      attempts++;
    }
    const logs = await proc.getLogs();
    // If stdout has content, the mount exists
    const mounted = !!(logs.stdout && logs.stdout.includes('s3fs'));
    console.log('isR2Mounted check:', mounted, 'stdout:', logs.stdout?.slice(0, 100));
    return mounted;
  } catch (err) {
    console.log('isR2Mounted error:', err);
    return false;
  }
}

/**
 * Verify that the R2 mount is actually writable by writing and reading a probe file.
 * s3fs can mount lazily without verifying credentials, so we need an explicit check.
 */
async function verifyR2Writable(sandbox: Sandbox): Promise<boolean> {
  const probeFile = `${R2_MOUNT_PATH}/.write-probe`;
  try {
    const probeValue = `probe-${Date.now()}`;
    const proc = await sandbox.startProcess(
      `echo "${probeValue}" > ${probeFile} && cat ${probeFile}`,
    );
    let attempts = 0;
    while (proc.status === 'running' && attempts < 20) {
      // eslint-disable-next-line no-await-in-loop -- intentional sequential polling
      await new Promise((r) => setTimeout(r, 500));
      attempts++;
    }
    const logs = await proc.getLogs();
    const writable = !!(logs.stdout && logs.stdout.includes(probeValue));
    if (!writable) {
      console.error('R2 mount write verification failed. stdout:', logs.stdout?.slice(0, 200), 'stderr:', logs.stderr?.slice(0, 200));
    }
    return writable;
  } catch (err) {
    console.error('R2 write verification error:', err);
    return false;
  }
}

/**
 * Mount R2 bucket for persistent storage
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns true if mounted and writable, false otherwise
 */
export async function mountR2Storage(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  // Skip if R2 credentials are not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log(
      'R2 storage not configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_ID)',
    );
    return false;
  }

  // Check if already mounted first - this avoids errors and is faster
  if (await isR2Mounted(sandbox)) {
    console.log('R2 bucket already mounted at', R2_MOUNT_PATH);
    return true;
  }

  const bucketName = getR2BucketName(env);
  try {
    console.log('Mounting R2 bucket', bucketName, 'at', R2_MOUNT_PATH);
    await sandbox.mountBucket(bucketName, R2_MOUNT_PATH, {
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      // Pass credentials explicitly since we use R2_* naming instead of AWS_*
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });

    // Verify the mount is actually writable (s3fs can mount without credential validation)
    if (!await verifyR2Writable(sandbox)) {
      console.error('R2 bucket mounted but not writable — credentials may be invalid');
      return false;
    }

    console.log('R2 bucket mounted and verified writable at', R2_MOUNT_PATH);
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // "already in use" means it's already mounted — treat as success
    if (errorMessage.includes('already in use')) {
      console.log('R2 bucket already mounted at', R2_MOUNT_PATH);
      return true;
    }

    console.log('R2 mount error:', errorMessage);

    // Check again if it's mounted - the error might be misleading
    if (await isR2Mounted(sandbox)) {
      console.log('R2 bucket is mounted despite error');
      return true;
    }

    // Don't fail if mounting fails - moltbot can still run without persistent storage
    console.error('Failed to mount R2 bucket:', err);
    return false;
  }
}
