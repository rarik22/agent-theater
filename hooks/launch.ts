// Pure helpers for starting, describing and stopping the theater server process, and for
// opening the live view in a browser. No `$` here, so the tests can call them directly.

import type { PluginOptions, ProcessSpawnResult, SessionMachine } from 'claude-code'

export const DEFAULT_PORT = 8790
export const PACKAGE = 'agent-theater'

export type Settings = { port: number; autostart: boolean; sample: boolean; config: string | null }

export type Launch = 'local' | 'npx'

export type Plan = { launch: Launch; argv: string[] } | { error: string; isFinal: true }

/** The plugin's options with their defaults, each checked. */
export function settingsOf(options: PluginOptions): Settings {
  const port = Number(options.port)

  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    autostart: options.autostart !== false,
    sample: options.sample === true,
    config: typeof options.config === 'string' && options.config.trim() !== '' ? options.config.trim() : null,
  }
}

/** A version npx can pin (`0.1.0`, `1.2.3-beta.1`), or null. */
export function pinnable(version: unknown): string | null {
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null
}

/**
 * How to run the server: `node <root>/server.mjs` when the plugin's own folder holds the
 * app (the repository root installed as the plugin), else `npx -y agent-theater@<version>`
 * (through cmd.exe on Windows, where npx is a .cmd script).
 */
export function launchPlan(input: {
  settings: Settings
  root: string
  hasLocalServer: boolean
  machine: SessionMachine | null
  version: string | null
}): Plan {
  const { settings, root, hasLocalServer, machine, version } = input
  // empty lists mean the engine could not tell; judge only lists it filled
  if (machine !== null && machine.runtimes.length > 0 && !machine.runtimes.includes('node')) {
    return { error: 'Node.js 24 or newer is not on the PATH', isFinal: true }
  }
  const args = ['--port', String(settings.port), ...(settings.config !== null ? ['--config', settings.config] : [])]
  if (hasLocalServer) return { launch: 'local', argv: ['node', `${root}/server.mjs`, ...args] }
  if (machine !== null && machine.packageManagers.length > 0 && !machine.packageManagers.includes('npm')) {
    return { error: 'npx (npm) is not on the PATH', isFinal: true }
  }
  const spec = version !== null ? `${PACKAGE}@${version}` : PACKAGE
  if (machine?.sysname !== 'Windows_NT') return { launch: 'npx', argv: ['npx', '-y', spec, ...args] }
  if (settings.config !== null && /["%!^&|<>]/.test(settings.config)) {
    return { error: 'the config path holds characters cmd.exe reads as commands', isFinal: true }
  }

  return { launch: 'npx', argv: ['cmd.exe', '/d', '/s', '/c', 'npx', '-y', spec, ...args] }
}

/** Why the server process ended, in a few words, from its last output. */
export function exitReason(
  tail: string,
  ended: ProcessSpawnResult | null,
  launch: Launch,
  port: number,
): { message: string; isFinal: boolean } {
  if (/EADDRINUSE|address already in use/i.test(tail)) return { message: `port ${port} is in use`, isFinal: false }
  if (launch === 'npx' && /E404|404 Not Found|not in this registry|No matching version/i.test(tail)) {
    return { message: `${PACKAGE} is not on npm yet`, isFinal: true }
  }
  if (launch === 'npx' && /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network/i.test(tail)) {
    return { message: 'npx could not reach the npm registry', isFinal: false }
  }
  if (/EBADENGINE|Unsupported engine|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError/i.test(tail)) {
    return { message: 'the server needs Node.js 24 or newer', isFinal: true }
  }
  // before Node 24 the server's entry check is false, so it exits at once and silently
  if (ended?.code === 0 && tail.trim() === '') {
    return { message: 'the server exited at once (it needs Node.js 24 or newer)', isFinal: true }
  }
  // the server ends with code 0 on SIGINT or SIGTERM
  if (ended?.code === 0) return { message: 'the server was stopped', isFinal: false }
  if (typeof ended?.signal === 'string') return { message: `the server was stopped (${ended.signal})`, isFinal: false }

  return { message: `the server exited (code ${ended?.code ?? 'unknown'})`, isFinal: false }
}

/** The PID listening on the port in `netstat -ano -p TCP` output (Windows), or null. */
export function listenerPid(netstat: string, port: number): number | null {
  for (const line of netstat.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (match !== null && Number(match[1]) === port) return Number(match[2])
  }

  return null
}

/** The command that opens a URL in the default browser on this system, or null. */
export function browserOpener(machine: SessionMachine, url: string): string[] | null {
  if (machine.sysname === 'Windows_NT') return ['rundll32', 'url.dll,FileProtocolHandler', url]
  if (machine.sysname === 'Darwin') return ['open', url]
  if (machine.sysname === '') return null
  if (/microsoft|wsl/i.test(machine.release)) {
    // WSL: the Windows browser reaches the server through localhost forwarding
    return [
      'sh',
      '-c',
      'if command -v wslview >/dev/null 2>&1; then wslview "$1"; else explorer.exe "$1"; fi >/dev/null 2>&1; exit 0',
      'sh',
      url,
    ]
  }

  // xdg-open may wait for the browser it starts, so it is left running in the background
  return ['sh', '-c', 'command -v xdg-open >/dev/null 2>&1 || exit 3; xdg-open "$1" >/dev/null 2>&1 &', 'sh', url]
}
