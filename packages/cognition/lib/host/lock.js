// run.lock：同一状态根只允许一个写入者。
// 死进程可接管；同一 pid 允许重开（测试/宿主重启）；别的活进程直接拒绝。

import { open, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readRecord(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function acquireLock(file, { clock = Date.now, pidAlive: alive = pidAlive } = {}) {
  const token = randomUUID();
  const record = {
    pid: process.pid,
    startedAt: new Date(clock()).toISOString(),
    token
  };

  let handle = null;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(record));
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;

    const held = await readRecord(file);
    const sameProcess = held?.pid === process.pid;
    const deadOwner = !held || !alive(held.pid);
    if (!sameProcess && !deadOwner) {
      throw new Error(
        `认知内核的状态根已有另一个进程在写（pid ${held?.pid}）；同一时刻只允许一个实例`
      );
    }
    // 同进程重开或接管死进程：原子覆盖锁记录。
    await writeFile(file, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  } finally {
    await handle?.close().catch(() => undefined);
  }

  return {
    token,
    async release() {
      const current = await readRecord(file);
      if (current?.token === token) await rm(file, { force: true }).catch(() => undefined);
    }
  };
}
