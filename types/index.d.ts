// The values the Agent Theater plugin keeps in `$.state`: one compact view of the
// theater server, written by the poller and read by the pane.

/** A lane of the pipeline as the pane draws it: one progress bar. */
export type TheaterLane = {
  id: string
  tag: string | null
  title: string | null
  status: string | null
  /** Stations passed. */
  done: number
  /** Stations in the lane; 0 when the server sent none. */
  total: number
  /** The tag of the station the lane is at, when the server says. */
  station: string | null
}

/** One agent row: its role, what it works on, its step and what it does. */
export type TheaterAgent = {
  id: string
  role: string
  work: string | null
  station: string | null
  action: string | null
  lane: string | null
}

/** A done/total pair and what it counts (`runs`, `agents`). */
export type TheaterCount = {
  done: number
  total: number
  label: string | null
}

export type TheaterStatus = 'idle' | 'starting' | 'live' | 'offline' | 'error'

export type TheaterView = {
  status: TheaterStatus
  port: number
  /** The live view in the browser. */
  url: string
  /** Why the server is not live, in a few words; null while live. */
  message: string | null
  /** True when this session started the server (and so may stop it). */
  isOwned: boolean
  mode: string | null
  isSample: boolean
  project: string | null
  jobs: TheaterCount | null
  features: TheaterCount | null
  lanes: TheaterLane[]
  agents: TheaterAgent[]
  /** Agents the server listed beyond the ones kept here. */
  moreAgents: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-theater': { view: Shaped<TheaterView> }
  }
}
