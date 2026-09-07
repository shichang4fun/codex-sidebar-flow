import { open, readFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';

// One lifecycle lock for install, launch and uninstall. A crashed waiter cannot
// permanently block the next launch; live or ambiguous owners are never evicted.
export async function acquireDesktopLock(root) {
  const file = path.join(root, '.launch-lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink()) throw Error('Unsafe launcher lock');
      const value = await readFile(file, 'utf8');
      const pid = Number(value);
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(pid) || pid > 2147483647) throw Error('Invalid lock owner');
      try { process.kill(pid, 0); throw Error('Desktop lifecycle operation already running'); }
      catch (check) { if (check.code !== 'ESRCH') throw check; }
      const after = await lstat(file);
      if (before.ino !== after.ino || before.dev !== after.dev || await readFile(file, 'utf8') !== value) {
        throw Error('Launcher lock changed');
      }
      await unlink(file);
      continue;
    }
    await handle.writeFile(String(process.pid));
    const identity = await handle.stat();
    return async () => {
      await handle.close();
      try {
        const current = await lstat(file);
        if (current.ino === identity.ino && current.dev === identity.dev) await unlink(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }
  throw Error('Unable to acquire launcher lock');
}
