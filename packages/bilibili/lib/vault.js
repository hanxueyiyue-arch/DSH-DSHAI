import { randomUUID } from 'node:crypto';

export class VaultError extends Error {}

// 只接受 B 站扫码/手动导入得到的三个字段；拒绝头注入与超长值，任何错误信息都不包含凭据。
export function validateCredentials(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const pick = (raw, key) => {
    const value = String(raw ?? '').trim();
    const match = value.match(new RegExp('(?:^|;)\\s*' + key + '=([^;]+)', 'i'));
    return (match ? match[1] : value.replace(new RegExp('^' + key + '\\s*=', 'i'), ''))
      .replace(/^["'\s]+|["';\s]+$/g, '').trim();
  };
  const credentials = {
    sessdata: pick(source.sessdata, 'SESSDATA'),
    bili_jct: pick(source.bili_jct, 'bili_jct'),
    buvid3: pick(source.buvid3, 'buvid3'),
  };
  const invalid = credentials.sessdata.length < 20 || credentials.sessdata.length > 8192
    || !/^[0-9a-fA-F]{32}$/.test(credentials.bili_jct)
    || Object.values(credentials).some(value => /[\r\n;\x00-\x1f\x7f]/.test(value) || value.length > 8192);
  if (invalid) throw new VaultError('凭据不完整或格式无效，请重新扫码。');
  return credentials;
}

export function cookieHeader(credentials) {
  const parts = [`SESSDATA=${credentials.sessdata}`, `bili_jct=${credentials.bili_jct}`];
  if (credentials.buvid3) parts.push(`buvid3=${credentials.buvid3}`);
  return parts.join('; ');
}

/**
 * Step 4：登录凭证只存在于当前进程内存。
 *
 * 明确边界：
 * - 构造时不读取任何文件（包括历史 credentials.bin）；
 * - save() 只更新内存缓存，不落盘、不做 DPAPI、不生成备份；
 * - 进程退出/崩溃后缓存自然消失，下次启动必须重新扫码。
 *
 * `file`/`protect`/`unprotect` 参数仅为兼容旧调用方保留，会被忽略；
 * 旧凭证文件不由本模块读取、迁移、覆盖或删除。
 */
export function createCredentialVault({ now = () => Date.now() } = {}) {
  let cached = null;
  let updatedAt = null;

  function status() {
    return {
      hasCredentials: cached !== null,
      updatedAt,
      storage: 'memory-only',
    };
  }

  async function load() {
    return cached;
  }

  async function save(input) {
    const credentials = validateCredentials(input);
    cached = Object.freeze({ ...credentials });
    updatedAt = new Date(now()).toISOString();
    return true;
  }

  async function clear() {
    cached = null;
    updatedAt = null;
    return true;
  }

  return {
    load,
    save,
    clear,
    status,
    hasCached: () => cached !== null,
    cached: () => cached,
    runId: randomUUID(),
  };
}
