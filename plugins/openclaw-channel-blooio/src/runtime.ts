let runtime: any = null;
let configFn: (() => any) | null = null;
let logger: any = null;

export function initBlooioRuntime(opts: {
  runtime: any;
  getConfig: () => any;
  logger: any;
}): void {
  runtime = opts.runtime;
  configFn = opts.getConfig;
  logger = opts.logger;
}

export function getBlooioRuntime(): any {
  if (!runtime) throw new Error('Bloo.io plugin runtime not initialized');
  return runtime;
}

export function getBlooioConfig(): any {
  if (!configFn) throw new Error('Bloo.io plugin not initialized');
  return configFn();
}

export function getBlooioLogger(): any {
  return logger;
}
