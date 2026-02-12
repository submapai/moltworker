import { describe, it, expect, beforeEach } from 'vitest';
import { syncToR2, restoreFromR2 } from './sync';
import {
  createMockEnv,
  createMockR2Bucket,
  createMockSandbox,
  suppressConsole,
} from '../test-utils';

describe('syncToR2', () => {
  beforeEach(() => {
    suppressConsole();
  });

  describe('configuration checks', () => {
    it('returns error when MOLTBOT_BUCKET is not configured', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv({ MOLTBOT_BUCKET: undefined as any });

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('R2 storage is not configured');
    });
  });

  describe('sanity checks', () => {
    it('returns error when source has no config file', async () => {
      const { sandbox, existsMock } = createMockSandbox();
      existsMock
        .mockResolvedValueOnce({
          success: true,
          exists: false,
          path: '/root/.openclaw/openclaw.json',
          timestamp: '',
        })
        .mockResolvedValueOnce({
          success: true,
          exists: false,
          path: '/root/.clawdbot/clawdbot.json',
          timestamp: '',
        });

      const env = createMockEnv();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Sync aborted: no config file found');
    });
  });

  describe('sync execution', () => {
    it('syncs config files to R2 bucket', async () => {
      const bucket = createMockR2Bucket();
      const { sandbox, existsMock, listFilesMock, readFileMock } = createMockSandbox();

      existsMock.mockResolvedValueOnce({
        success: true,
        exists: true,
        path: '/root/.openclaw/openclaw.json',
        timestamp: '',
      });

      listFilesMock
        // config dir
        .mockResolvedValueOnce({
          success: true,
          files: [
            {
              name: 'openclaw.json',
              absolutePath: '/root/.openclaw/openclaw.json',
              type: 'file',
              size: 100,
              relativePath: 'openclaw.json',
              modifiedAt: '',
              mode: '',
              permissions: {},
            },
          ],
          count: 1,
          path: '/root/.openclaw',
          timestamp: '',
        })
        // workspace dir
        .mockResolvedValueOnce({
          success: true,
          files: [
            {
              name: 'IDENTITY.md',
              absolutePath: '/root/clawd/IDENTITY.md',
              type: 'file',
              size: 50,
              relativePath: 'IDENTITY.md',
              modifiedAt: '',
              mode: '',
              permissions: {},
            },
          ],
          count: 1,
          path: '/root/clawd',
          timestamp: '',
        })
        // skills dir
        .mockResolvedValueOnce({
          success: true,
          files: [],
          count: 0,
          path: '/root/clawd/skills',
          timestamp: '',
        });

      readFileMock
        .mockResolvedValueOnce({
          success: true,
          content: '{"key":"value"}',
          path: '/root/.openclaw/openclaw.json',
          timestamp: '',
        })
        .mockResolvedValueOnce({
          success: true,
          content: '# Identity',
          path: '/root/clawd/IDENTITY.md',
          timestamp: '',
        });

      const env = createMockEnv({ MOLTBOT_BUCKET: bucket as unknown as R2Bucket });

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(true);
      expect(result.lastSync).toBeTruthy();
      expect(bucket.put).toHaveBeenCalledWith('openclaw/openclaw.json', '{"key":"value"}');
      expect(bucket.put).toHaveBeenCalledWith('workspace/IDENTITY.md', '# Identity');
      expect(bucket.put).toHaveBeenCalledWith('.last-sync', expect.any(String));
    });

    it('excludes .lock, .log, .tmp files', async () => {
      const bucket = createMockR2Bucket();
      const { sandbox, existsMock, listFilesMock, readFileMock } = createMockSandbox();

      existsMock.mockResolvedValueOnce({
        success: true,
        exists: true,
        path: '/root/.openclaw/openclaw.json',
        timestamp: '',
      });

      listFilesMock
        .mockResolvedValueOnce({
          success: true,
          files: [
            {
              name: 'openclaw.json',
              absolutePath: '/root/.openclaw/openclaw.json',
              type: 'file',
              size: 100,
              relativePath: 'openclaw.json',
              modifiedAt: '',
              mode: '',
              permissions: {},
            },
            {
              name: 'gateway.lock',
              absolutePath: '/root/.openclaw/gateway.lock',
              type: 'file',
              size: 10,
              relativePath: 'gateway.lock',
              modifiedAt: '',
              mode: '',
              permissions: {},
            },
            {
              name: 'debug.log',
              absolutePath: '/root/.openclaw/debug.log',
              type: 'file',
              size: 500,
              relativePath: 'debug.log',
              modifiedAt: '',
              mode: '',
              permissions: {},
            },
          ],
          count: 3,
          path: '/root/.openclaw',
          timestamp: '',
        })
        .mockResolvedValueOnce({
          success: true,
          files: [],
          count: 0,
          path: '/root/clawd',
          timestamp: '',
        })
        .mockResolvedValueOnce({
          success: true,
          files: [],
          count: 0,
          path: '/root/clawd/skills',
          timestamp: '',
        });

      readFileMock.mockResolvedValue({ success: true, content: '{}', path: '', timestamp: '' });

      const env = createMockEnv({ MOLTBOT_BUCKET: bucket as unknown as R2Bucket });

      await syncToR2(sandbox, env);

      // Only openclaw.json should be synced, not .lock or .log
      expect(bucket.put).toHaveBeenCalledWith('openclaw/openclaw.json', '{}');
      expect(bucket.put).not.toHaveBeenCalledWith('openclaw/gateway.lock', expect.anything());
      expect(bucket.put).not.toHaveBeenCalledWith('openclaw/debug.log', expect.anything());
    });

    it('excludes skills/ from workspace sync', async () => {
      const bucket = createMockR2Bucket();
      const { sandbox, existsMock, listFilesMock, readFileMock } = createMockSandbox();

      existsMock.mockResolvedValueOnce({
        success: true,
        exists: true,
        path: '/root/.openclaw/openclaw.json',
        timestamp: '',
      });

      listFilesMock
        .mockResolvedValueOnce({
          success: true,
          files: [],
          count: 0,
          path: '/root/.openclaw',
          timestamp: '',
        })
        .mockResolvedValueOnce({
          success: true,
          files: [
            {
              name: 'IDENTITY.md',
              absolutePath: '/root/clawd/IDENTITY.md',
              type: 'file',
              size: 50,
              relativePath: 'IDENTITY.md',
              modifiedAt: '',
              mode: '',
              permissions: {},
            },
            {
              name: 'skill.json',
              absolutePath: '/root/clawd/skills/test/skill.json',
              type: 'file',
              size: 30,
              relativePath: 'skills/test/skill.json',
              modifiedAt: '',
              mode: '',
              permissions: {},
            },
          ],
          count: 2,
          path: '/root/clawd',
          timestamp: '',
        })
        .mockResolvedValueOnce({
          success: true,
          files: [],
          count: 0,
          path: '/root/clawd/skills',
          timestamp: '',
        });

      readFileMock.mockResolvedValue({
        success: true,
        content: 'content',
        path: '',
        timestamp: '',
      });

      const env = createMockEnv({ MOLTBOT_BUCKET: bucket as unknown as R2Bucket });

      await syncToR2(sandbox, env);

      expect(bucket.put).toHaveBeenCalledWith('workspace/IDENTITY.md', 'content');
      expect(bucket.put).not.toHaveBeenCalledWith(
        'workspace/skills/test/skill.json',
        expect.anything(),
      );
    });

    it('uses legacy config dir when clawdbot.json exists', async () => {
      const bucket = createMockR2Bucket();
      const { sandbox, existsMock, listFilesMock, readFileMock } = createMockSandbox();

      existsMock
        .mockResolvedValueOnce({
          success: true,
          exists: false,
          path: '/root/.openclaw/openclaw.json',
          timestamp: '',
        })
        .mockResolvedValueOnce({
          success: true,
          exists: true,
          path: '/root/.clawdbot/clawdbot.json',
          timestamp: '',
        });

      listFilesMock
        .mockResolvedValueOnce({
          success: true,
          files: [
            {
              name: 'clawdbot.json',
              absolutePath: '/root/.clawdbot/clawdbot.json',
              type: 'file',
              size: 100,
              relativePath: 'clawdbot.json',
              modifiedAt: '',
              mode: '',
              permissions: {},
            },
          ],
          count: 1,
          path: '/root/.clawdbot',
          timestamp: '',
        })
        .mockResolvedValueOnce({
          success: true,
          files: [],
          count: 0,
          path: '/root/clawd',
          timestamp: '',
        })
        .mockResolvedValueOnce({
          success: true,
          files: [],
          count: 0,
          path: '/root/clawd/skills',
          timestamp: '',
        });

      readFileMock.mockResolvedValue({ success: true, content: '{}', path: '', timestamp: '' });

      const env = createMockEnv({ MOLTBOT_BUCKET: bucket as unknown as R2Bucket });

      await syncToR2(sandbox, env);

      expect(listFilesMock).toHaveBeenCalledWith('/root/.clawdbot', {
        recursive: true,
        includeHidden: true,
      });
    });
  });
});

describe('restoreFromR2', () => {
  beforeEach(() => {
    suppressConsole();
  });

  it('returns error when MOLTBOT_BUCKET is not configured', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ MOLTBOT_BUCKET: undefined as any });

    const result = await restoreFromR2(sandbox, env);

    expect(result.success).toBe(false);
    expect(result.error).toBe('R2 storage is not configured');
  });

  it('skips restore when no backup exists', async () => {
    const bucket = createMockR2Bucket();
    const { sandbox } = createMockSandbox();

    const env = createMockEnv({ MOLTBOT_BUCKET: bucket as unknown as R2Bucket });

    const result = await restoreFromR2(sandbox, env);

    expect(result.success).toBe(true);
    expect(result.details).toBe('No backup found');
  });

  it('restores files from R2 to sandbox', async () => {
    const bucket = createMockR2Bucket();
    // Pre-populate the bucket
    bucket._store.set('.last-sync', '2026-02-09T12:00:00Z');
    bucket._store.set('openclaw/openclaw.json', '{"key":"value"}');
    bucket._store.set('workspace/IDENTITY.md', '# My Identity');
    bucket._store.set('skills/test/SKILL.md', '# Test Skill');

    const { sandbox, mkdirMock, writeFileMock } = createMockSandbox();

    const env = createMockEnv({ MOLTBOT_BUCKET: bucket as unknown as R2Bucket });

    const result = await restoreFromR2(sandbox, env);

    expect(result.success).toBe(true);
    expect(result.lastSync).toBe('2026-02-09T12:00:00Z');

    expect(mkdirMock).toHaveBeenCalledWith('/root/.openclaw', { recursive: true });
    expect(writeFileMock).toHaveBeenCalledWith('/root/.openclaw/openclaw.json', '{"key":"value"}');
    expect(writeFileMock).toHaveBeenCalledWith('/root/clawd/IDENTITY.md', '# My Identity');
    expect(writeFileMock).toHaveBeenCalledWith('/root/clawd/skills/test/SKILL.md', '# Test Skill');
  });
});
