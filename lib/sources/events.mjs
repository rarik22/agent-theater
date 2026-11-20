// The theater's event API, for agent tools other than Claude Code: lanes and agents announced by
// small JSON events, posted to POST /api/events or appended to a JSON Lines file (sources.events).
// Documented in docs/EVENTS.md. The store lives in memory; nothing is written anywhere.
//
//   { "lane": "checkout", "stations": ["PLAN", "BUILD", "TEST"] }                 a lane and its stations
//   { "agent": "a1", "lane": "checkout", "station": "BUILD", "action": "edit" }    an agent at work
//   { "agent": "a1", "status": "done" }                                           it finished
//   { "lane": "checkout", "status": "done" }                                      the lane's work is done
//   { "progress": { "done": 3, "total": 10 } }                                     the controller's counter
import { KINDS, ROLES, redact } from '../classify.mjs';
import { roleOfWord, stationTag } from '../rules.mjs';
import { readRange, statOrNull } from './files.mjs';

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ROLE_SET = new Set(ROLES);
const KIND_SET = new Set(KINDS);

const timeOf = (v, now) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : now;
};

export class EventStore {
  constructor({ maxAgents = 64, maxLanes = 32, maxStations = 6 } = {}) {
    this.max = { agents: maxAgents, lanes: maxLanes, stations: maxStations };
    this.lanes = new Map();
    this.agents = new Map();
    this.ended = [];
    this.progress = null;
    this.file = { path: null, offset: 0 };
    this.count = 0;
  }

  /** Apply one event (an object); returns null when accepted, else the reason it was refused. */
  apply(ev, now = Date.now()) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return 'an event is a JSON object';
    const at = timeOf(ev.time ?? ev.at, now);
    if (ev.progress && typeof ev.progress === 'object') {
      const done = Number(ev.progress.done);
      const total = Number(ev.progress.total);
      if (!Number.isInteger(done) || !Number.isInteger(total) || done < 0 || total < done) return 'progress needs whole numbers done <= total';
      this.progress = { done, total, at };
      this.count += 1;
      return null;
    }
    const laneKey = ev.lane === undefined || ev.lane === null ? null : String(ev.lane);
    if (laneKey !== null && !KEY_RE.test(laneKey)) return 'lane must be a short name (letters, digits, . _ : -)';
    if (laneKey !== null) {
      const lane = this.#lane(laneKey, at);
      if (!lane) return 'too many lanes';
      if (Array.isArray(ev.stations)) lane.stations = ev.stations.slice(0, this.max.stations).map((s) => stationTag(s));
      if (typeof ev.tag === 'string') lane.tag = ev.tag;
      if (ev.agent === undefined && typeof ev.status === 'string') {
        const s = ev.status.toLowerCase();
        if (s === 'done' || s === 'completed') Object.assign(lane, { status: 'completed', endMs: at });
        else if (s === 'stopped' || s === 'killed' || s === 'failed') Object.assign(lane, { status: 'killed', endMs: at });
        else if (s === 'running' || s === 'working') Object.assign(lane, { status: 'running', endMs: null });
      }
      lane.lastMs = Math.max(lane.lastMs, at);
    }
    if (ev.agent !== undefined) {
      const id = String(ev.agent);
      if (!KEY_RE.test(id)) return 'agent must be a short id (letters, digits, . _ : -)';
      let a = this.agents.get(id);
      if (!a) {
        if (this.agents.size >= this.max.agents) this.#dropOldestAgent();
        a = { id, lane: null, station: null, role: null, kind: 'think', text: '', tag: null, startMs: at, lastMs: at, actionAt: at, endMs: null, ended: null };
        this.agents.set(id, a);
      }
      if (laneKey !== null) a.lane = laneKey;
      if (ev.station !== undefined && a.lane) {
        const lane = this.lanes.get(a.lane);
        if (typeof ev.station === 'number' && Number.isInteger(ev.station) && ev.station >= 0) a.station = Math.min(ev.station, this.max.stations - 1);
        else if (typeof ev.station === 'string' && lane) {
          const tag = stationTag(ev.station);
          let i = lane.stations.indexOf(tag);
          if (i < 0 && lane.stations.length < this.max.stations) {
            lane.stations.push(tag);
            i = lane.stations.length - 1;
          }
          a.station = i >= 0 ? i : lane.stations.length - 1;
        }
      }
      if (typeof ev.role === 'string' && ROLE_SET.has(ev.role)) a.role = ev.role;
      if (typeof ev.action === 'string' && KIND_SET.has(ev.action)) {
        a.kind = ev.action;
        a.actionAt = at;
      }
      if (typeof ev.text === 'string') a.text = redact(ev.text, 90);
      if (typeof ev.tag === 'string') a.tag = ev.tag;
      a.lastMs = Math.max(a.lastMs, at);
      if (typeof ev.status === 'string') {
        const s = ev.status.toLowerCase();
        if (s === 'done' || s === 'finished' || s === 'stopped' || s === 'failed') Object.assign(a, { endMs: at, ended: s === 'done' || s === 'finished' ? 'finished' : 'stopped' });
        else if (s === 'working' || s === 'running') Object.assign(a, { endMs: null, ended: null });
      }
      if (a.ended) {
        this.ended.push({ ...a });
        if (this.ended.length > 200) this.ended.splice(0, this.ended.length - 200);
      }
    }
    if (laneKey === null && ev.agent === undefined) return 'an event names a lane, an agent or progress';
    this.count += 1;
    return null;
  }

  #lane(key, at) {
    let lane = this.lanes.get(key);
    if (lane) return lane;
    if (this.lanes.size >= this.max.lanes) {
      const old = [...this.lanes.values()].filter((l) => l.status !== 'running').sort((a, b) => a.lastMs - b.lastMs)[0];
      if (!old) return null;
      this.lanes.delete(old.key);
    }
    lane = { key, tag: null, stations: [], status: 'running', startMs: at, endMs: null, lastMs: at };
    this.lanes.set(key, lane);
    return lane;
  }

  #dropOldestAgent() {
    const old = [...this.agents.values()].sort((a, b) => a.lastMs - b.lastMs)[0];
    if (old) this.agents.delete(old.id);
  }

  /** Read the lines appended to a JSON Lines file since the last call. */
  follow(path, now = Date.now()) {
    if (!path) return { ok: false };
    const st = statOrNull(path);
    if (!st) return { ok: false };
    if (this.file.path !== path || st.size < this.file.offset) this.file = { path, offset: 0 };
    if (st.size > this.file.offset) {
      const end = Math.min(st.size, this.file.offset + 4 * 1024 * 1024);
      const buf = readRange(path, this.file.offset, end);
      const cut = buf.lastIndexOf(0x0a);
      if (cut >= 0) {
        for (const line of buf.subarray(0, cut + 1).toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            this.apply(JSON.parse(line), now);
          } catch {
            // a line that is not JSON is skipped
          }
        }
        this.file.offset += cut + 1;
      }
    }
    return { ok: true };
  }

  /** Live agents at `now`: not ended and heard from within quietMs. */
  liveAgents(now, quietMs) {
    return [...this.agents.values()].filter((a) => !a.ended && now - a.lastMs <= quietMs);
  }

  /** A role for an agent: its own, else from its station's word, else coder. */
  roleOf(a) {
    if (a.role) return a.role;
    const lane = a.lane ? this.lanes.get(a.lane) : null;
    const word = lane && a.station !== null ? lane.stations[a.station] : null;
    return roleOfWord(word) || 'coder';
  }
}
