// The log behind a click on an agent: its transcript, read on demand, as a list of entries.
//
// The private view (?public=0) gets what happened: the task the agent was given, what it said, each
// tool call (with its command, file or pattern) and each result, background-command notices and stops,
// every text redacted (secrets, e-mail addresses, home folders) and cut to a sane length. Public mode
// gets only the steps: when each action started and its generic phrase, repeats folded together, with
// no free text at all.
//
// Files are read incrementally (a second request reads only the new lines). A first read starts at
// most TAIL_BYTES from the end, and at most MAX_ENTRIES entries are kept, so a very long transcript
// shows its latest part and says how much it left out.
import { classifyToolUse, privateText, publicPhrase, redact, redactBlock } from './classify.mjs';
import { GENERIC_RULES } from './rules.mjs';
import { readRange, statOrNull } from './sources/files.mjs';

const MAX_ENTRIES = 1500;
const TAIL_BYTES = 24 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;
const LIMITS = { task: 6000, user: 3000, say: 4000, detail: 2000, result: 1500 };

/** The text of a message's content (a string, or text blocks), or ''. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** What a tool call works on, for the private log: its command, file, pattern, address or task. */
export function toolDetail(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  if (typeof i.command === 'string') return i.command;
  if (typeof i.file_path === 'string') return i.file_path;
  if (typeof i.notebook_path === 'string') return i.notebook_path;
  if (typeof i.pattern === 'string') return `${i.pattern}${typeof i.path === 'string' ? `  in ${i.path}` : ''}`;
  if (typeof i.url === 'string') return i.url;
  if (typeof i.query === 'string') return i.query;
  if (Array.isArray(i.todos)) return i.todos.map((t) => `${t && t.status === 'completed' ? '[x]' : t && t.status === 'in_progress' ? '[>]' : '[ ]'} ${t && t.content ? t.content : ''}`).join('\n');
  if (typeof i.prompt === 'string') return `${typeof i.subagent_type === 'string' ? `${i.subagent_type}: ` : ''}${i.prompt}`;
  if (typeof i.name === 'string') return i.name;
  const keys = Object.keys(i);
  return keys.length ? JSON.stringify(i).slice(0, 400) : '';
}

function emptyFile() {
  return { offset: 0, size: 0, entries: [], omitted: 0, sawTask: false };
}

export class AgentLogs {
  constructor(rules = GENERIC_RULES) {
    this.rules = rules;
    this.files = new Map();
  }

  /** The parsed entries of one transcript (read on from where the last call stopped), or null. */
  read(path) {
    const st = path ? statOrNull(path) : null;
    if (!st) return null;
    let file = this.files.get(path);
    if (!file || st.size < file.offset) {
      file = emptyFile();
      if (st.size > TAIL_BYTES) {
        // start near the end, on a line boundary; everything before counts as left out
        file.offset = st.size - TAIL_BYTES;
        const head = readRange(path, file.offset, Math.min(st.size, file.offset + 1024 * 1024));
        const nl = head.indexOf(0x0a);
        file.offset += nl >= 0 ? nl + 1 : head.length;
        file.omitted = -1;
        file.sawTask = true;
      }
      this.files.set(path, file);
      // a handful of files at most are open in someone's panel; forget the oldest
      if (this.files.size > 16) this.files.delete(this.files.keys().next().value);
    }
    while (file.offset < st.size) {
      const end = Math.min(st.size, file.offset + CHUNK);
      const buf = readRange(path, file.offset, end);
      const cut = buf.lastIndexOf(0x0a);
      if (cut < 0) break;
      this.#consume(file, buf.subarray(0, cut + 1).toString('utf8'));
      file.offset += cut + 1;
    }
    file.size = st.size;
    return file;
  }

  #push(file, entry) {
    file.entries.push(entry);
    if (file.entries.length > MAX_ENTRIES) {
      const drop = file.entries.length - MAX_ENTRIES;
      file.entries.splice(0, drop);
      if (file.omitted >= 0) file.omitted += drop;
    }
  }

  #consume(file, text) {
    for (const line of text.split('\n')) {
      if (line.length < 2) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const t = Date.parse(row?.timestamp);
      const at = Number.isFinite(t) ? t : null;
      const content = row?.message?.content;
      if (row?.type === 'assistant' && Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) this.#push(file, { t: at, type: 'say', text: b.text });
          else if (b.type === 'tool_use') {
            const input = b.input && typeof b.input === 'object' ? b.input : {};
            const name = String(b.name || 'tool');
            this.#push(file, { t: at, type: 'tool', id: b.id || null, name, ...classifyToolUse(name, input, this.rules), text: privateText(name, input), what: toolDetail(name, input) });
          }
        }
        continue;
      }
      if (row?.type !== 'user') continue;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_result') this.#push(file, { t: at, type: 'result', id: b.tool_use_id || null, text: textOf(b.content), error: Boolean(b.is_error) });
        }
      }
      const said = textOf(content).trim();
      if (!said) continue;
      if (said.startsWith('[Request interrupted by user')) {
        this.#push(file, { t: at, type: 'stop' });
        continue;
      }
      const note = /<task-notification>[\s\S]*?<status>([a-z_]+)<\/status>/i.exec(said);
      if (note) {
        this.#push(file, { t: at, type: 'notice', status: note[1].toLowerCase() });
        continue;
      }
      this.#push(file, { t: at, type: file.sawTask ? 'user' : 'task', text: said });
      file.sawTask = true;
    }
  }
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * Shape parsed entries for the page. Public: [{ t, text, kind, count, until }] steps only (the action's
 * generic phrase; repeats of one phrase folded into one step). Private: every entry, redacted.
 */
export function shapeLog(file, { publicMode, role }) {
  const entries = file ? file.entries : [];
  const omitted = file ? (file.omitted < 0 ? 'some' : file.omitted) : 0;
  if (publicMode) {
    const steps = [];
    for (const e of entries) {
      let text;
      let kind;
      if (e.type === 'tool') {
        kind = e.kind || 'think';
        // `detail` is the classifier's own key (e2e, build, unit, ...), never text from the transcript
        text = publicPhrase(kind, role, kind === 'wait' ? e.wait || 'task' : null, { detail: typeof e.detail === 'string' ? e.detail : null, background: Boolean(e.background) });
      } else if (e.type === 'stop') {
        kind = 'stop';
        text = 'stopped';
      } else if (e.type === 'notice') {
        kind = 'notice';
        text = e.status === 'completed' ? 'a background command finished' : 'a background command ended';
      } else continue;
      const last = steps[steps.length - 1];
      if (last && last.text === text) {
        last.count += 1;
        last.until = iso(e.t) || last.until;
      } else steps.push({ t: iso(e.t), kind, text, count: 1, until: iso(e.t) });
    }
    return { entries: steps.slice(-600), omitted: steps.length > 600 ? 'some' : omitted };
  }
  const out = entries.map((e) => {
    const base = { t: iso(e.t), type: e.type };
    if (e.type === 'tool') return { ...base, name: e.name, kind: e.kind, text: redact(e.text, 140), detail: redactBlock(e.what, LIMITS.detail), background: Boolean(e.background) || undefined, id: e.id || undefined };
    if (e.type === 'result') {
      const full = String(e.text || '');
      return { ...base, text: redactBlock(full, LIMITS.result), error: e.error || undefined, chars: full.length > LIMITS.result ? full.length : undefined, id: e.id || undefined };
    }
    if (e.type === 'notice') return { ...base, status: e.status };
    if (e.type === 'stop') return base;
    return { ...base, text: redactBlock(e.text, LIMITS[e.type] || 3000) };
  });
  return { entries: out, omitted };
}
