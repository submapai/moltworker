import { blooioChannel } from './src/channel.js';
import { handleBlooioWebhookRequest } from './src/webhook.js';
import { initBlooioRuntime } from './src/runtime.js';

const plugin = {
  id: 'blooio',
  name: 'Bloo.io',
  description: 'Bloo.io channel plugin (iMessage/WhatsApp)',
  configSchema: { type: 'object', additionalProperties: false, properties: {} },
  register(api: any) {
    initBlooioRuntime({
      runtime: api.runtime,
      getConfig: () => api.getConfig(),
      logger: api.logger,
    });
    api.logger.info('Bloo.io channel plugin loaded');
    api.registerChannel({ plugin: blooioChannel });
    api.registerHttpHandler(handleBlooioWebhookRequest);
  },
};

export default plugin;
