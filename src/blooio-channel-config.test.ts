import { afterEach, describe, expect, it } from 'vitest';
import { blooioChannel, getBlooioApiKey } from '../submodules/channels/blooio/src/channel';

const ORIGINAL_BLOOIO_API_KEY = process.env.BLOOIO_API_KEY;

afterEach(() => {
  if (ORIGINAL_BLOOIO_API_KEY === undefined) {
    delete process.env.BLOOIO_API_KEY;
  } else {
    process.env.BLOOIO_API_KEY = ORIGINAL_BLOOIO_API_KEY;
  }
});

describe('blooio channel config', () => {
  it('prefers channels.blooio.apiKey over BLOOIO_API_KEY env', () => {
    process.env.BLOOIO_API_KEY = 'env-key';
    const apiKey = getBlooioApiKey({
      channels: {
        blooio: {
          apiKey: 'config-key',
        },
      },
    });
    expect(apiKey).toBe('config-key');
  });

  it('falls back to BLOOIO_API_KEY env when config key is absent', () => {
    process.env.BLOOIO_API_KEY = 'env-only-key';
    const apiKey = getBlooioApiKey({
      channels: {
        blooio: {
          enabled: true,
        },
      },
    });
    expect(apiKey).toBe('env-only-key');
  });

  it('declares outbound in blooio config schema', () => {
    expect((blooioChannel as any).configSchema.properties.outbound).toMatchObject({
      type: 'boolean',
      default: true,
    });
  });
});
