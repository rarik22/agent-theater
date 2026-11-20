// Speech bubbles' words and the log a click on an agent opens: what the server says about each agent
// (public phrases only in public mode; the agent's own words, redacted, in the private view) and the
// log behind it (steps only in public mode; the redacted transcript in the private view).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { redactBlock, sayOf } from '../lib/classify.mjs';
import { AgentLogs, shapeLog, toolDetail } from '../lib/agentlog.mjs';
import { sampleAgentLog, sampleStateAt } from '../lib/sample.mjs';
import { buildAgentLog, buildLiveState, createTheater, sayFor } from '../lib/state.mjs';
import { saidAt } from '../lib/transcripts.mjs';
import { setupClaudeHome } from './claude-home.mjs';
import { NOW } from './helpers.mjs';

let fx;
before(() => {
  fx = setupClaudeHome();
});
after(() => fx.cleanup());

const SECRETS = /ghp_|alice@|\/home\/dev|example\.com/;

test('what an agent says: the first sentence of its message, without markdown, redacted', () => {
  assert.equal(sayOf('Now I will **fix** the `cart` total. Then the tests.'), 'Now I will fix the cart total.');
  assert.equal(sayOf('## Plan\n- Read /home/dev/shop/src/cart.ts first\n- then edit'), 'Plan Read ~/shop/src/cart.ts first then edit');
  assert.equal(sayOf('Done.'), 'Done.');
  assert.equal(sayOf('   \n  '), null);
  assert.ok(sayOf('x'.repeat(400)).length <= 140);
  assert.ok(!SECRETS.test(sayOf('Using token ghp_abcdefgh12345678 for alice@example.com.')));
  // the log keeps lines, but not secrets or home folders
  assert.equal(redactBlock('a\n\n\n\nb  c\r\nC:\\Users\\dev\\x'), 'a\n\nb c\n~\\x');
});

test('bubbles say the phrase in public mode, the agent\'s fresh words in private', async () => {
  const theater = createTheater(fx.cfg);
  const pub = await buildLiveState(theater, { now: NOW, publicMode: true });
  const pri = await buildLiveState(theater, { now: NOW, publicMode: false });
  for (const a of pub.agents) {
    assert.equal(a.say, a.action.text, 'public: the bubble is the generic phrase');
    assert.ok(Number.isFinite(Date.parse(a.action.since)));
  }
  const fixer = pri.agents.find((a) => a.id === 'b2fix');
  assert.equal(fixer.say, 'Fixing the cart total rounding in ~/shop/src/cart.ts.');
  assert.ok(!SECRETS.test(JSON.stringify(pub.agents)) && !SECRETS.test(JSON.stringify(pri.agents)));
  // words go stale after 15 minutes, and never come from the future
  assert.equal(sayFor('running tests', { at: NOW - 20 * 60_000, text: 'old' }, { publicMode: false, atMs: NOW }), 'running tests');
  assert.equal(sayFor('running tests', { at: NOW + 60_000, text: 'later' }, { publicMode: false, atMs: NOW }), 'running tests');
  assert.equal(sayFor('running tests', { at: NOW, text: 'mine' }, { publicMode: true, atMs: NOW }), 'running tests');
  // a replayed moment says what the agent had said by then
  const entry = theater.transcripts.get(theater.agentIndex.get('b2fix').transcript);
  assert.equal(saidAt(entry, Date.parse('2026-11-19T11:58:00Z')), null);
  assert.match(saidAt(entry, NOW).text, /^Fixing the cart/);
});

test('a public log is steps only: times, generic phrases, repeats folded, no transcript text', async () => {
  const theater = createTheater(fx.cfg);
  const log = await buildAgentLog(theater, 'b2fix', { now: NOW, publicMode: true });
  assert.equal(log.status, 'working');
  assert.equal(log.role, 'fixer');
  assert.equal(log.public, true);
  assert.deepEqual(log.entries.map((e) => e.text), ['fixing the code', 'running tests (background)']);
  for (const e of log.entries) assert.deepEqual(Object.keys(e).sort(), ['count', 'kind', 't', 'text', 'until']);
  assert.ok(!/cart|vitest|rounding|Fix the/i.test(JSON.stringify(log)));
});

test('a private log is the transcript: task, words, tool calls and results, redacted', async () => {
  const theater = createTheater(fx.cfg);
  const log = await buildAgentLog(theater, 'b2fix', { now: NOW, publicMode: false });
  assert.deepEqual(log.entries.map((e) => e.type), ['task', 'tool', 'say', 'tool', 'result']);
  const [task, edit, said, bash, result] = log.entries;
  assert.equal(task.text, 'Fix the rounding bug in the cart total. Questions to ***.');
  assert.equal(edit.name, 'Edit');
  assert.equal(edit.detail, 'src/cart.ts');
  assert.match(said.text, /^Fixing the \*\*cart total\*\* rounding in ~\/shop\/src\/cart\.ts\. The token \*\*\* stays/);
  assert.equal(bash.detail, 'pnpm vitest run');
  assert.equal(bash.background, true);
  assert.match(result.text, /running in background/);
  assert.ok(!SECRETS.test(JSON.stringify(log)));
  // a finished agent's log still opens; an unknown or malformed id is null
  const done = await buildAgentLog(theater, 'a1impl', { now: NOW, publicMode: false });
  assert.equal(done.status, 'finished');
  assert.equal(done.entries[0].detail, '~/shop/src/cart.ts');
  assert.equal(await buildAgentLog(theater, 'nobody', { now: NOW }), null);
  assert.equal(await buildAgentLog(theater, '../../etc/passwd', { now: NOW }), null);
});

test('log reading is incremental and keeps the latest entries of a long transcript', () => {
  const logs = new AgentLogs();
  const theater = createTheater(fx.cfg);
  return buildLiveState(theater, { now: NOW }).then(() => {
    const path = theater.agentIndex.get('b2fix').transcript;
    const a = logs.read(path);
    const n = a.entries.length;
    assert.equal(logs.read(path).entries.length, n, 'a second read adds nothing new');
    assert.equal(logs.read('/no/such/file.jsonl'), null);
    // shapes: what a tool works on
    assert.equal(toolDetail('Grep', { pattern: 'total', path: 'src' }), 'total  in src');
    assert.equal(toolDetail('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }), '[x] a\n[ ] b');
    const many = { entries: Array.from({ length: 9 }, (_, i) => ({ t: NOW + i, type: 'tool', kind: 'edit', name: 'Edit' })), omitted: 3 };
    const pub = shapeLog(many, { publicMode: true, role: 'coder' });
    assert.deepEqual(pub.entries.map((e) => [e.text, e.count]), [['writing code', 9]]);
    assert.equal(pub.omitted, 3);
  });
});

test('event-API agents keep a history for their log', async () => {
  const theater = createTheater(fx.cfg);
  for (const ev of [
    { lane: 'checkout', stations: ['Plan', 'Build'] },
    { agent: 'bot-1', lane: 'checkout', station: 'Build', action: 'edit', text: 'editing cart.ts for alice@example.com' },
    { agent: 'bot-1', action: 'test' },
  ]) assert.equal(theater.events.apply(ev, NOW), null);
  const pub = await buildAgentLog(theater, 'ev-bot-1', { now: NOW, publicMode: true });
  assert.deepEqual(pub.entries.map((e) => e.text), ['writing code', 'running tests']);
  const pri = await buildAgentLog(theater, 'ev-bot-1', { now: NOW, publicMode: false });
  assert.equal(pri.entries[0].text, 'editing cart.ts for ***');
  const state = await buildLiveState(theater, { now: NOW, publicMode: false });
  assert.equal(state.agents.find((a) => a.id === 'ev-bot-1').say, 'editing cart.ts for ***');
});

test('sample agents talk and keep logs too, replayed from the simulation', () => {
  const g = 1_795_003_560;
  const pub = sampleStateAt({}, g);
  const pri = sampleStateAt({}, g, { publicMode: false });
  for (const a of pub.agents) assert.equal(a.say, a.action.text);
  assert.ok(pri.agents.every((a) => typeof a.say === 'string' && /^[A-Z]/.test(a.say)));
  const id = pub.agents.find((a) => a.role === 'coder').id;
  const log = sampleAgentLog(id, g, { publicMode: true });
  assert.equal(log.status, 'working');
  assert.ok(log.entries.length >= 2 && log.entries.every((e) => e.text && !e.type));
  const full = sampleAgentLog(id, g, { publicMode: false });
  assert.equal(full.entries[0].type, 'task');
  assert.ok(full.entries.some((e) => e.type === 'tool') && full.entries.some((e) => e.type === 'say'));
  assert.equal(sampleAgentLog('nope', g), null);
});
