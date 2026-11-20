// Incremental, read-only parser for agent transcripts (JSON Lines that can grow to tens of MB).
// Each file is read once; later calls only read the bytes appended since. Only a compact list of
// tool uses is kept: time, tool name, classified action and a redacted private description; and what the
// agent last said it was doing (the first sentence of each message, redacted), for its speech bubble.
// It also follows two things the stage needs to tell a working agent from a stopped one:
//   - background commands: a Bash or PowerShell tool use with run_in_background:true is in flight
//     until a later task notification names its tool-use id (<tool-use-id>toolu_...</tool-use-id>,
//     status completed, failed or killed); `bg` holds the ones still in flight, `bgDone` when each
//     finished;
//   - a stop: TaskStop interrupts the agent, which leaves a user line "[Request interrupted by user]"
//     and no result; `interruptedAt` is set until the agent writes anything again.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { classifyToolUse, privateText, sayOf } from './classify.mjs';
import { GENERIC_RULES } from './rules.mjs';

const TS_RE = /"timestamp":"([^"]+)"/;
const RESULT_ID_RE = /"tool_use_id":"([^"]+)"/g;
const NOTIFY_ID_RE = /<tool-use-id>([A-Za-z0-9_-]+)<\/tool-use-id>/g;
const INTERRUPT_RE = /"type":"user"[\s\S]*\[Request interrupted by user/;
const CHUNK = 8 * 1024 * 1024;
// the agent's own words kept per transcript (newest last), for bubbles in live and replayed frames
const MAX_SAID = 300;

function readRange(path, start, end) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(end - start);
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

/** A user line that is the stop marker itself (not a tool result that happens to quote it). */
function isInterrupt(line) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return false;
  }
  if (row?.type !== 'user') return false;
  const content = row.message?.content;
  if (typeof content === 'string') return content.trim().startsWith('[Request interrupted by user');
  return Array.isArray(content) && content.some((b) => b?.type === 'text' && String(b.text || '').trim().startsWith('[Request interrupted by user'));
}

function emptyEntry() {
  return { offset: 0, size: 0, mtimeMs: 0, firstAt: null, lastAt: null, lastAssistantAt: null, uses: [], said: null, saids: [], pending: new Set(), bg: new Map(), bgDone: new Map(), interruptedAt: null };
}

export class TranscriptCache {
  /** rules: the compiled rules (rules.mjs) that classify each tool use. */
  constructor(rules = GENERIC_RULES) {
    this.rules = rules;
    this.entries = new Map();
    this.firstTimes = new Map();
  }

  /** Parse (or continue parsing) one transcript. Returns null when the file cannot be read. */
  get(path) {
    let st;
    try {
      st = statSync(path);
    } catch {
      return null;
    }
    let entry = this.entries.get(path);
    if (!entry || st.size < entry.offset) {
      entry = emptyEntry();
      this.entries.set(path, entry);
    }
    entry.mtimeMs = st.mtimeMs;
    entry.size = st.size;
    while (entry.offset < st.size) {
      const end = Math.min(st.size, entry.offset + CHUNK);
      let buf;
      try {
        buf = readRange(path, entry.offset, end);
      } catch {
        return entry;
      }
      let cut = buf.lastIndexOf(0x0a);
      if (cut < 0) {
        // A line longer than one chunk: read on until its newline, or stop at the unfinished tail.
        if (end >= st.size) break;
        let probe = end;
        while (cut < 0 && probe < st.size) {
          const more = readRange(path, probe, Math.min(st.size, probe + CHUNK));
          const at = more.indexOf(0x0a);
          if (at >= 0) cut = probe - entry.offset + at;
          probe += more.length;
          if (more.length === 0) break;
        }
        if (cut < 0) break;
        buf = readRange(path, entry.offset, entry.offset + cut + 1);
      }
      const text = buf.subarray(0, cut + 1).toString('utf8');
      this.#consume(entry, text);
      entry.offset += cut + 1;
    }
    if (entry.firstAt) this.firstTimes.set(path, entry.firstAt);
    return entry;
  }

  #consume(entry, text) {
    for (const line of text.split('\n')) {
      if (line.length < 2) continue;
      const ts = TS_RE.exec(line);
      const at = ts ? Date.parse(ts[1]) : NaN;
      if (Number.isFinite(at)) {
        if (entry.firstAt === null) entry.firstAt = at;
        if (entry.lastAt === null || at > entry.lastAt) entry.lastAt = at;
      }
      if (line.includes('"tool_use_id"')) {
        for (const m of line.matchAll(RESULT_ID_RE)) entry.pending.delete(m[1]);
      }
      if (line.includes('<tool-use-id>')) {
        // a task notification: the background command it names has finished
        for (const m of line.matchAll(NOTIFY_ID_RE)) {
          if (entry.bg.has(m[1])) {
            entry.bg.delete(m[1]);
            entry.bgDone.set(m[1], Number.isFinite(at) ? at : entry.lastAt);
          }
        }
      }
      if (line.includes('[Request interrupted by user') && INTERRUPT_RE.test(line) && isInterrupt(line)) {
        entry.interruptedAt = Number.isFinite(at) ? at : entry.lastAt;
        continue;
      }
      if (!line.includes('"type":"assistant"')) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type !== 'assistant') continue;
      const rowAt = Date.parse(row.timestamp);
      if (Number.isFinite(rowAt)) entry.lastAssistantAt = Math.max(entry.lastAssistantAt ?? 0, rowAt);
      // the agent wrote again after a stop: it was resumed
      if (entry.interruptedAt !== null && Number.isFinite(rowAt) && rowAt > entry.interruptedAt) entry.interruptedAt = null;
      const content = Array.isArray(row.message?.content) ? row.message.content : [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          const text = sayOf(block.text);
          if (text) {
            entry.said = { at: Number.isFinite(rowAt) ? rowAt : entry.lastAt, text };
            entry.saids.push(entry.said);
            if (entry.saids.length > MAX_SAID) entry.saids.splice(0, entry.saids.length - MAX_SAID);
          }
          continue;
        }
        if (block?.type !== 'tool_use') continue;
        const input = block.input && typeof block.input === 'object' ? block.input : {};
        const use = {
          at: Number.isFinite(rowAt) ? rowAt : entry.lastAt,
          id: block.id || null,
          name: String(block.name || ''),
          ...classifyToolUse(block.name, input, this.rules),
          text: privateText(block.name, input),
        };
        entry.uses.push(use);
        if (block.id) entry.pending.add(block.id);
        if (block.id && use.background && (use.name === 'Bash' || use.name === 'PowerShell')) entry.bg.set(block.id, use);
      }
    }
  }

  /** First timestamp of a transcript without parsing all of it (read once, then remembered). */
  firstTimestamp(path) {
    if (this.firstTimes.has(path)) return this.firstTimes.get(path);
    let at = null;
    try {
      const size = statSync(path).size;
      const head = readRange(path, 0, Math.min(size, 512 * 1024)).toString('utf8');
      const m = TS_RE.exec(head);
      if (m && Number.isFinite(Date.parse(m[1]))) at = Date.parse(m[1]);
    } catch {
      at = null;
    }
    if (at !== null) this.firstTimes.set(path, at);
    return at;
  }
}

/**
 * Background commands in flight at time t, newest first: started at or before t, not finished by t
 * (no notification yet, or one after t), and younger than maxMs (a command whose agent was stopped
 * never gets a notification). For t = now this is the live view; for a past t, the replay's.
 */
export function backgroundAt(entry, t, maxMs = 3 * 3600_000) {
  if (!entry) return [];
  const out = [];
  const consider = (use, doneAt) => {
    if (!use || !(use.at <= t) || t - use.at > maxMs) return;
    if (doneAt !== undefined && doneAt !== null && doneAt <= t) return;
    out.push(use);
  };
  for (const use of entry.bg.values()) consider(use, undefined);
  for (const use of entry.uses) if (use.background && entry.bgDone.has(use.id)) consider(use, entry.bgDone.get(use.id));
  return out.sort((a, b) => b.at - a.at);
}

/** What the agent last said at or before time `t` ({ at, text }), or null. */
export function saidAt(entry, t) {
  if (!entry?.saids?.length) return null;
  for (let i = entry.saids.length - 1; i >= 0; i -= 1) if ((entry.saids[i].at ?? 0) <= t) return entry.saids[i];
  return null;
}

/** The tool use in effect at time `t` (last one at or before t). */
export function useAt(uses, t) {
  let lo = 0;
  let hi = uses.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((uses[mid].at ?? 0) <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 ? uses[found] : null;
}
