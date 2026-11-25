export function loadTestHooks({ configPath, env, requireModule, warn = console.warn }) {
  if (env === '1' && !configPath) throw new Error('TEST_HOOKS_REQUIRED');
  if (!configPath) return null;
  if (env !== '1') {
    warn('[dsh-dshai-bilibili] ignoring testHooks outside DSH_HOST_TEST_ASSEMBLY');
    return null;
  }
  let hooks;
  try {
    hooks = requireModule(configPath);
  } catch (err) {
    throw new Error('TEST_HOOKS_LOAD_FAILED: ' + (err && err.message ? err.message : String(err)));
  }
  if (!hooks || typeof hooks !== 'object') throw new Error('TEST_HOOKS_INVALID');
  return hooks;
}

export function requireTestHook(hooks, name) {
  const factory = hooks && hooks[name];
  if (typeof factory !== 'function') throw new Error('TEST_HOOKS_INCOMPLETE: ' + name);
  return factory;
}
