import { describe, it, expect, beforeEach } from 'vitest';
import { mountR2Storage } from './r2';
import {
  createMockEnv,
  createMockSandbox,
  suppressConsole,
} from '../test-utils';

describe('mountR2Storage (deprecated no-op)', () => {
  beforeEach(() => {
    suppressConsole();
  });

  it('returns true (no-op)', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv();

    const result = await mountR2Storage(sandbox, env);

    expect(result).toBe(true);
  });

  it('logs deprecation notice', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv();

    await mountR2Storage(sandbox, env);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('deprecated'),
    );
  });
});
