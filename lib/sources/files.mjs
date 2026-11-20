// Cached, read-only file access shared by the source readers: a file is read again only when its size
// or modification time changed. Nothing here writes.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

const fileCache = new Map();

/** Read a text file, re-reading only when its size or mtime changed. Throws when it cannot be read. */
export function readCached(path) {
  const st = statSync(path);
  const hit = fileCache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  const text = readFileSync(path, 'utf8');
  const entry = { size: st.size, mtimeMs: st.mtimeMs, text, parsed: undefined };
  fileCache.set(path, entry);
  if (fileCache.size > 4000) fileCache.delete(fileCache.keys().next().value);
  return entry;
}

/** { ok, data } for a JSON file (parsed once per change); ok false when missing or invalid. */
export function readJson(path) {
  if (!path) return { ok: false, data: null };
  try {
    const entry = readCached(path);
    if (entry.parsed === undefined) entry.parsed = JSON.parse(entry.text);
    return { ok: true, data: entry.parsed };
  } catch {
    return { ok: false, data: null };
  }
}

/** Bytes [start, end) of a file. */
export function readRange(path, start, end) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.max(0, end - start));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return got === buf.length ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** statSync that returns null instead of throwing. */
export function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
