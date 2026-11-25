// 管理界面外壳：等 webServer 就绪后才挂载，不影响无界面宿主。
import { registerCognitionUi } from './routes.js';

export const name = 'dsh-dshai-cognition-ui';
export const inject = ['webServer', 'connection'];

export function apply(ctx) {
  const service = ctx.get('cognition');
  if (!service) return () => {};
  return registerCognitionUi({ ctx, service });
}
