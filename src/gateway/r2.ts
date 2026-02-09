import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';

/**
 * @deprecated R2 storage now uses direct bucket binding instead of s3fs mount.
 * This function is a no-op kept for backward compatibility.
 */
export async function mountR2Storage(_sandbox: Sandbox, _env: MoltbotEnv): Promise<boolean> {
  console.log('[r2] mountR2Storage is deprecated — backup/restore now uses direct R2 binding');
  return true;
}
