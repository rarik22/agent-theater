// Agent Theater HD · hd-log.mjs
// The log panel a click on an agent opens, on the stage itself: who the agent is, what it says it is
// doing now, and its log from /api/agent (steps only in public mode; the task, its messages, tool calls
// and results in the private view). It refreshes every few seconds while open and keeps its place
// unless you were at the bottom, where new lines arrive. Everything is written as text nodes: nothing
// from a transcript is ever parsed as HTML.

const ROLE_NAME = { setup: 'Setup', coder: 'Coder', reviewer: 'Reviewer', fixer: 'Fixer', preparer: 'Preparer', merger: 'Merger', verifier: 'Verifier', helper: 'Helper' };
const STATUS = { working: 'working', finished: 'finished', failed: 'failed', stopped: 'stopped', ended: 'gone quiet' };
const REFRESH_MS = 3000;
const CLAMP_LINES = 6;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** "1h 4m", "3m 20s", "45s" between two ISO times. */
export function spanText(fromIso, toIso) {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 1000) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/** A block of text that folds to a few lines with a button to show all of it. */
function foldable(tag, cls, text) {
  const box = el('div', 'fold');
  const body = el(tag, cls, text);
  box.appendChild(body);
  const lines = String(text || '').split('\n').length;
  if (lines > CLAMP_LINES || String(text || '').length > 600) {
    body.classList.add('clamped');
    const more = el('button', 'more', 'Show all');
    more.type = 'button';
    more.addEventListener('click', () => {
      const clamped = body.classList.toggle('clamped');
      more.textContent = clamped ? 'Show all' : 'Show less';
    });
    box.appendChild(more);
  }
  return box;
}

/** One entry of the private log as a list item. */
function entryItem(e, time) {
  const li = el('li', `e ${e.type || 'step'}`);
  if (e.t) li.appendChild(el('time', null, time(e.t)));
  const main = el('div', 'main');
  li.appendChild(main);
  switch (e.type) {
    case 'task':
      main.appendChild(el('div', 'kicker', 'Task'));
      main.appendChild(foldable('div', 'text', e.text));
      break;
    case 'user':
      main.appendChild(el('div', 'kicker', 'Message'));
      main.appendChild(foldable('div', 'text', e.text));
      break;
    case 'say':
      main.appendChild(foldable('div', 'text', e.text));
      break;
    case 'tool': {
      const line = el('div', 'line');
      const name = e.name || 'tool';
      line.appendChild(el('b', 'name', name));
      // descriptions of file and search tools start with the tool's name: say it once
      const desc = String(e.text || '').startsWith(`${name} `) ? String(e.text).slice(name.length + 1) : String(e.text || '');
      if (desc && desc !== name) line.appendChild(el('span', 'desc', desc));
      if (e.background) line.appendChild(el('span', 'badge', 'background'));
      main.appendChild(line);
      if (e.detail && !desc.includes(e.detail)) main.appendChild(foldable('pre', 'detail', e.detail));
      break;
    }
    case 'result':
      if (e.error) li.classList.add('error');
      main.appendChild(foldable('pre', 'out', e.text || '(no output)'));
      if (e.chars) main.appendChild(el('div', 'note', `${e.chars.toLocaleString()} characters, cut`));
      break;
    case 'notice':
      main.appendChild(el('div', 'text', `A background command ${e.status === 'completed' ? 'finished' : e.status === 'failed' ? 'failed' : 'ended'}`));
      break;
    case 'stop':
      main.appendChild(el('div', 'text', 'Stopped'));
      break;
    case 'event': {
      const bits = [e.status, e.kind, e.station].filter(Boolean).join(' · ');
      if (bits) main.appendChild(el('div', 'kicker', bits));
      if (e.text) main.appendChild(el('div', 'text', e.text));
      break;
    }
    default:
      main.appendChild(el('div', 'text', e.text || ''));
  }
  return li;
}

/** One step of the public log: when, what (the generic phrase), how many times and for how long. */
function stepItem(s, time) {
  const li = el('li', 'e step');
  li.appendChild(el('time', null, time(s.t)));
  const main = el('div', 'main');
  const line = el('div', 'line');
  line.appendChild(el('span', 'phrase', s.text ? s.text[0].toUpperCase() + s.text.slice(1) : ''));
  if (s.count > 1) line.appendChild(el('span', 'badge', `×${s.count}`));
  const span = spanText(s.t, s.until);
  if (span) line.appendChild(el('span', 'dim', span));
  main.appendChild(line);
  li.appendChild(main);
  return li;
}

/**
 * The panel. `fetchLog(id)` resolves to /api/agent's answer (or throws); `onSelect(id|null)` hears
 * which agent's log is open; `tz` is the clock's time zone.
 */
export function createLogPanel({ root, fetchLog, onSelect = () => {}, tz }) {
  const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz });
  const time = (iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? fmt.format(new Date(ms)) : '';
  };
  const $ = (sel) => root.querySelector(sel);
  const state = { id: null, timer: null, sig: '', opener: null, seq: 0 };

  function close() {
    if (!state.id) return;
    state.id = null;
    state.sig = '';
    clearTimeout(state.timer);
    root.hidden = true;
    onSelect(null);
    if (state.opener && document.contains(state.opener)) state.opener.focus();
    state.opener = null;
  }

  function render(log) {
    const sig = `${log.status}|${log.say}|${log.entries.length}|${log.entries.at(-1)?.t}|${log.entries.at(-1)?.until}|${log.entries.at(-1)?.count}`;
    $('.log-role').textContent = `${ROLE_NAME[log.role] || 'Agent'}${log.tag ? ` · ${log.tag}` : ''}`;
    const where = [log.lane, log.stationTag].filter(Boolean).join(' · ');
    const since = log.since ? `since ${time(log.since)}` : '';
    $('.log-sub').textContent = [where, STATUS[log.status] || log.status, since].filter(Boolean).join(' — ');
    const now = $('.log-now');
    now.hidden = !log.say;
    now.textContent = log.say ? `“${log.say[0].toUpperCase()}${log.say.slice(1)}”` : '';
    $('.log-mode').textContent = log.public
      ? 'Public view: steps only, nothing from the transcript itself. Open the stage with ?public=0 on your own screen for the full log.'
      : 'Private view: the transcript, with secrets, e-mail addresses and home folders removed.';
    if (sig === state.sig) return;
    state.sig = sig;
    const list = $('.log-list');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    const first = !list.childElementCount;
    list.replaceChildren(...(log.entries.length ? log.entries.map((e) => (log.public ? stepItem(e, time) : entryItem(e, time))) : [el('li', 'e empty', log.available === false ? 'Its transcript can no longer be read.' : 'Nothing logged yet.')]));
    if (log.omitted) list.prepend(el('li', 'e note', log.omitted === 'some' ? 'Earlier entries are not shown.' : `${log.omitted} earlier entries are not shown.`));
    if (first || atBottom) list.scrollTop = list.scrollHeight;
  }

  async function refresh(seq) {
    if (!state.id || seq !== state.seq) return;
    try {
      const log = await fetchLog(state.id);
      if (seq !== state.seq) return;
      render(log);
      $('.log-error').hidden = true;
      // a finished agent's log does not change any more
      if (log.status !== 'working') return;
    } catch (err) {
      if (seq !== state.seq) return;
      const box = $('.log-error');
      box.hidden = false;
      box.textContent = err && err.message ? err.message : 'The log could not be loaded.';
    }
    if (state.id && seq === state.seq) state.timer = setTimeout(() => refresh(seq), REFRESH_MS);
  }

  function open(id, { opener = null } = {}) {
    if (!id) return close();
    if (state.id === id && !root.hidden) return;
    clearTimeout(state.timer);
    state.id = id;
    state.sig = '';
    state.seq += 1;
    state.opener = opener;
    $('.log-list').replaceChildren(el('li', 'e empty', 'Loading…'));
    $('.log-role').textContent = 'Agent';
    $('.log-sub').textContent = '';
    $('.log-now').hidden = true;
    $('.log-error').hidden = true;
    root.hidden = false;
    onSelect(id);
    $('.log-close').focus({ preventScroll: true });
    refresh(state.seq);
  }

  $('.log-close').addEventListener('click', close);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.id) close();
  });
  return { open, close, get id() {
    return state.id;
  } };
}
