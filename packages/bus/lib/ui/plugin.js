// 总线设置界面外壳：只依赖 cognition-bus 与宿主 webServer；无界面宿主自动跳过。
import { registerBusUi } from './routes.js';

export const name = 'dsh-dshai-bus-ui';
export const inject = ['webServer', 'connection'];

export function apply(ctx) {
  const facade = ctx.get('cognition-bus');
  if (!facade) return () => {};
  return registerBusUi({ ctx, facade });
}
