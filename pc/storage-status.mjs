import fs from 'node:fs';
import path from 'node:path';

export const MIN_FREE_BYTES = 512 * 1024 * 1024;
export function readStorageStatus(root, reserveBytes = MIN_FREE_BYTES) {
  try {
    let target = path.resolve(root);
    while (!fs.existsSync(target)) { const parent = path.dirname(target); if (parent === target) throw new Error('No storage ancestor'); target = parent; }
    const stat = fs.statfsSync(target, { bigint: true });
    const available = Number(stat.bavail * stat.bsize), total = Number(stat.blocks * stat.bsize);
    if (!Number.isFinite(available) || available < 0 || !(total > 0)) throw new Error('Unknown storage capacity');
    return { state: available < reserveBytes ? 'low' : 'ready', available_bytes: available, total_bytes: total,
      reserve_bytes: reserveBytes, checked_at_utc: new Date().toISOString() };
  } catch {
    return { state: 'unknown', available_bytes: null, total_bytes: null, reserve_bytes: reserveBytes, checked_at_utc: new Date().toISOString() };
  }
}

/** Reserve enough room to finalize the current session; never deletes or overwrites recordings. */
export function createStorageGuard({ root, onStatus = () => {}, isRecording = () => false, stop = () => {},
  read = () => readStorageStatus(root), intervalMs = 15000, timers = true } = {}) {
  let pending = null;
  function refresh() { const value = read(); onStatus(value); return value; }
  function tick() {
    const value = refresh();
    if (value.state === 'low' && isRecording() && !pending) {
      pending = Promise.resolve().then(() => stop('low_disk_space')).finally(() => { pending = null; });
      pending.catch(() => {});
    }
    return pending ?? Promise.resolve();
  }
  refresh();
  const timer = timers ? setInterval(tick, intervalMs) : null; timer?.unref();
  return { refresh, tick,
    beforeStart() {
      const value = refresh();
      if (value.state !== 'ready') throw Object.assign(new Error(value.state === 'low' ? 'Insufficient free disk space; previous recordings retained' : 'Could not read storage capacity'), { statusCode: 507 });
    },
    close() { clearInterval(timer); return pending?.catch(() => {}) ?? Promise.resolve(); },
  };
}
