// Pure helpers: turn the server's /api/state JSON into the compact view the pane and the
// status line draw. Every field of the state is optional; nothing here throws on a missing,
// null or oddly typed one. Only fields the server sends are shown (public mode strips
// commands, paths and names server-side); nothing is added.

import type { TheaterAgent, TheaterCount, TheaterLane, TheaterView } from '../types'

export const MAX_AGENTS = 40
export const MAX_LANES = 16
const MAX_TEXT = 160

type Json = Record<string, unknown>

const asObject = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** A short single-line string, or null for anything blank or not a string. */
export function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat === '') return null

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A whole number at or above zero, or null. */
export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function pair(done: unknown, total: unknown, label: unknown): TheaterCount | null {
  const d = count(done)
  const t = count(total)
  if (d === null || t === null) return null

  return { done: d, total: t, label: text(label, 24)?.toLowerCase() ?? null }
}

function laneOf(raw: unknown, index: number): TheaterLane | null {
  const lane = asObject(raw)
  if (lane === null) return null
  const stations = asList(lane.stations).map(one => asObject(one))
  const total = stations.length
  const current = count(lane.current)
  const status = text(lane.status, 24)
  let done = count(lane.done) ?? current ?? 0
  if (status === 'completed' && total > 0) done = total
  if (total > 0) done = Math.min(done, total)
  const station = current !== null ? text(stations[current]?.tag, 40) : null

  return {
    id: text(lane.id, 24) ?? `lane ${index + 1}`,
    tag: text(lane.tag, 40),
    title: text(lane.title, 80),
    status,
    done,
    total,
    station,
  }
}

function agentOf(raw: unknown, index: number, lanes: Map<string, Json>): TheaterAgent | null {
  const agent = asObject(raw)
  if (agent === null) return null
  const lane = text(agent.lane, 24)
  let station = text(agent.stationTag, 40)
  if (station === null && lane !== null) {
    // the lane's station list names the step when the agent only carries an index
    const index = count(agent.station)
    const stations = asList(lanes.get(lane)?.stations)
    if (index !== null) station = text(asObject(stations[index])?.tag, 40)
  }

  return {
    id: text(agent.id, 120) ?? `agent-${index}`,
    role: text(agent.role, 24) ?? 'agent',
    work: text(agent.tag, 60) ?? text(agent.job, 60),
    station,
    action: text(asObject(agent.action)?.text),
    lane,
  }
}

/** What the state says, as the view's data fields. */
export function summarize(raw: unknown): Pick<
  TheaterView,
  'mode' | 'isSample' | 'project' | 'jobs' | 'features' | 'lanes' | 'agents' | 'moreAgents'
> {
  const state = asObject(raw) ?? {}
  const project = asObject(state.project) ?? {}
  const labels = asObject(project.labels) ?? {}
  const features = asObject(project.features)
  const pipeline = asObject(state.pipeline)
  const rawLanes = asList(pipeline?.lanes)
  const laneById = new Map<string, Json>()
  for (const one of rawLanes) {
    const lane = asObject(one)
    const id = text(lane?.id, 24)
    if (lane !== null && id !== null) laneById.set(id, lane)
  }
  const lanes = rawLanes
    .map((one, index) => laneOf(one, index))
    .filter((one): one is TheaterLane => one !== null)
    .slice(0, MAX_LANES)
  const allAgents = asList(state.agents)
  const agents = allAgents
    .map((one, index) => agentOf(one, index, laneById))
    .filter((one): one is TheaterAgent => one !== null)

  return {
    mode: text(state.mode, 16),
    isSample: state.sample === true,
    project: text(project.name, 60),
    jobs: pair(project.done, project.total, labels.jobs),
    features: features === null ? null : pair(features.done, features.total, labels.features),
    lanes,
    agents: agents.slice(0, MAX_AGENTS),
    moreAgents: Math.max(0, allAgents.length - MAX_AGENTS),
  }
}

/** How many agents the server listed. */
export const agentCount = (view: TheaterView): number => view.agents.length + view.moreAgents

/** `4 agents working · 18/40 runs`, the live part of the status line. */
export function liveLine(view: TheaterView): string {
  const n = agentCount(view)
  const parts = [n === 0 ? 'no agents working' : `${n} ${n === 1 ? 'agent' : 'agents'} working`]
  if (view.jobs !== null) {
    parts.push(`${view.jobs.done}/${view.jobs.total}${view.jobs.label !== null ? ` ${view.jobs.label}` : ''}`)
  }
  if (view.mode === 'replay') parts.push('replay')
  if (view.isSample) parts.push('sample')

  return parts.join(' · ')
}

/** The status line entry for the view; undefined clears it. */
export function statusLine(view: TheaterView): string | undefined {
  switch (view.status) {
    case 'live':
      return `Agent Theater · ${liveLine(view)}`
    case 'starting':
      return 'Agent Theater · starting…'
    case 'offline':
      return 'Agent Theater · off · /theater starts it'
    case 'error':
      return `Agent Theater · ${view.message ?? 'not running'} · /theater retries`
    default:
      return undefined
  }
}

/** The lane's bar figure: `3/5 · REVIEW`, with the lane's status once it ended. */
export function laneFigure(lane: TheaterLane): string {
  const parts = [lane.total > 0 ? `${lane.done}/${lane.total}` : `${lane.done}`]
  if (lane.station !== null && lane.status !== 'completed') parts.push(lane.station)
  if (lane.status !== null && lane.status !== 'running') parts.push(lane.status)

  return parts.join(' · ')
}

/** One agent row: `coder BUILD-SITE · CODE — reading code`. */
export function agentLine(agent: TheaterAgent): { head: string; tail: string } {
  const head = [agent.work, agent.station].filter((part): part is string => part !== null).join(' · ')

  return { head, tail: agent.action ?? '' }
}
