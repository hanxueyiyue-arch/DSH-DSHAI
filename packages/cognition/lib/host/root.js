// 解析状态根。宿主应显式传 stateRoot；测试传临时目录。
// 不读环境变量：host 可从自己的配置里取 DSH_HOME 再传进来。

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveStateRoot({ stateRoot = null, home = null } = {}) {
  if (stateRoot) return resolve(stateRoot);
  if (home) return join(resolve(home), 'dsh-dshai', 'cognition');
  return join(homedir(), '.dsh', 'dsh-dshai', 'cognition');
}
