#!/usr/bin/env node
// The agent-theater command: starts the theater server (see server.mjs for the options).
process.env.AGENT_THEATER_MAIN = '1';
await import('../server.mjs');
