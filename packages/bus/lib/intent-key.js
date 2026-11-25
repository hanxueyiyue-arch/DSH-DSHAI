/**
 * Intent public-key provisioning plugin.
 * Runs as a child fiber named `dsh-dshai-autonomy` so the Bilibili verifier's
 * fiber-name trust check accepts the key provided by the cognition bus.
 */
export const name = 'dsh-dshai-autonomy';
export const inject = [];
export function apply(ctx, config) {
  const publicInfo = config?.publicInfo;
  if (!publicInfo) throw new Error('bilibili intent public info is required');
  ctx.provide('bilibili-intent-public-key', publicInfo);
}