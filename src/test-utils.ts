/**
 * Shared test utilities for mocking sandbox and environment
 */
import { vi } from 'vitest';
import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from './types';

/**
 * Create a minimal MoltbotEnv object for testing
 */
export function createMockEnv(overrides: Partial<MoltbotEnv> = {}): MoltbotEnv {
  return {
    Sandbox: {} as any,
    ASSETS: {} as any,
    MOLTBOT_BUCKET: createMockR2Bucket() as unknown as R2Bucket,
    ...overrides,
  };
}

/**
 * Create a mock env with R2 credentials configured
 */
export function createMockEnvWithR2(overrides: Partial<MoltbotEnv> = {}): MoltbotEnv {
  return createMockEnv({
    R2_ACCESS_KEY_ID: 'test-key-id',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
    CF_ACCOUNT_ID: 'test-account-id',
    ...overrides,
  });
}

/**
 * Create a mock R2 bucket
 */
export function createMockR2Bucket() {
  const store = new Map<string, string>();
  return {
    put: vi.fn(async (key: string, value: string | ArrayBuffer | ReadableStream) => {
      store.set(key, typeof value === 'string' ? value : '(binary)');
    }),
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return {
        text: async () => value,
        arrayBuffer: async () => new TextEncoder().encode(value).buffer,
        body: null,
        key,
      };
    }),
    list: vi.fn(async (options?: { prefix?: string; cursor?: string }) => {
      const prefix = options?.prefix || '';
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key, size: store.get(key)!.length }));
      return { objects, truncated: false, cursor: undefined };
    }),
    head: vi.fn(async (key: string) => {
      return store.has(key) ? { key, size: store.get(key)!.length } : null;
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    _store: store,
  };
}

/**
 * Create a mock process object
 */
export function createMockProcess(
  stdout: string = '',
  options: { exitCode?: number; stderr?: string; status?: string } = {},
): Partial<Process> {
  const { exitCode = 0, stderr = '', status = 'completed' } = options;
  return {
    status: status as Process['status'],
    exitCode,
    getLogs: vi.fn().mockResolvedValue({ stdout, stderr }),
  };
}

export interface MockSandbox {
  sandbox: Sandbox;
  mountBucketMock: ReturnType<typeof vi.fn>;
  startProcessMock: ReturnType<typeof vi.fn>;
  listProcessesMock: ReturnType<typeof vi.fn>;
  containerFetchMock: ReturnType<typeof vi.fn>;
  existsMock: ReturnType<typeof vi.fn>;
  listFilesMock: ReturnType<typeof vi.fn>;
  readFileMock: ReturnType<typeof vi.fn>;
  writeFileMock: ReturnType<typeof vi.fn>;
  mkdirMock: ReturnType<typeof vi.fn>;
}

/**
 * Create a mock sandbox with configurable behavior
 */
export function createMockSandbox(
  options: {
    mounted?: boolean;
    processes?: Partial<Process>[];
  } = {},
): MockSandbox {
  const mountBucketMock = vi.fn().mockResolvedValue(undefined);
  const listProcessesMock = vi.fn().mockResolvedValue(options.processes || []);
  const containerFetchMock = vi.fn();
  const existsMock = vi.fn().mockResolvedValue({ success: true, exists: false, path: '', timestamp: '' });
  const listFilesMock = vi.fn().mockResolvedValue({ success: true, files: [], count: 0, path: '', timestamp: '' });
  const readFileMock = vi.fn().mockResolvedValue({ success: true, content: '', path: '', timestamp: '' });
  const writeFileMock = vi.fn().mockResolvedValue({ success: true, path: '', timestamp: '' });
  const mkdirMock = vi.fn().mockResolvedValue({ success: true, path: '', recursive: true, timestamp: '' });

  // Default: return empty stdout (not mounted), unless mounted: true
  const startProcessMock = vi
    .fn()
    .mockResolvedValue(
      options.mounted
        ? createMockProcess(
            's3fs on /data/moltbot type fuse.s3fs (rw,nosuid,nodev,relatime,user_id=0,group_id=0)\n',
          )
        : createMockProcess(''),
    );

  const sandbox = {
    mountBucket: mountBucketMock,
    listProcesses: listProcessesMock,
    startProcess: startProcessMock,
    containerFetch: containerFetchMock,
    wsConnect: vi.fn(),
    exists: existsMock,
    listFiles: listFilesMock,
    readFile: readFileMock,
    writeFile: writeFileMock,
    mkdir: mkdirMock,
  } as unknown as Sandbox;

  return {
    sandbox,
    mountBucketMock,
    startProcessMock,
    listProcessesMock,
    containerFetchMock,
    existsMock,
    listFilesMock,
    readFileMock,
    writeFileMock,
    mkdirMock,
  };
}

/**
 * Suppress console output during tests
 */
export function suppressConsole() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}
