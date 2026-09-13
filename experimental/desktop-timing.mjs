import { constants, openSync, closeSync, lstatSync, fstatSync, ftruncateSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Small local diagnostic ring, not telemetry. Only manager-produced timing
// summaries belong here. Never follow links or modify a non-private file.
export function createTimingWriter(root) {
  return record => {
    let fd;
    try {
      if (!isAbsolute(root)) return false;
      const parent = lstatSync(root);
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()
          || (parent.mode & 0o077) !== 0) return false;
      const line = JSON.stringify({ pid: process.pid, ...record }) + '\n';
      const size = Buffer.byteLength(line);
      if (size > 4096) return false;
      fd = openSync(join(root, 'timings.jsonl'), constants.O_WRONLY | constants.O_APPEND
        | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) return false;
      if (stat.size + size > 256 * 1024) ftruncateSync(fd, 0);
      writeSync(fd, line);
      return true;
    } catch { return false; }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
  };
}
