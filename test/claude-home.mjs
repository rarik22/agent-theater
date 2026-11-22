// A synthetic Claude Code home (~/.claude) for the generic "runs" model: one active project with a
// session that ran four workflows, an old run outside the window, a standalone subagent, and an idle
// project. Times are around NOW (2026-11-19 12:00 UTC); file times are set to match.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../lib/config.mjs';

export const SESSION = '1111aaaa-0000-4000-8000-000000000001';
export const PROJECT = '-home-dev-shop';
const ms = (hms, day = '19') => Date.parse(`2026-11-${day}T${hms}.000Z`);

const lines = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const use = (hms, id, name, input) => ({ type: 'assistant', timestamp: `2026-11-19T${hms}.000Z`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const say = (hms, text) => ({ type: 'assistant', timestamp: `2026-11-19T${hms}.000Z`, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const ask = (hms, text) => ({ type: 'user', timestamp: `2026-11-19T${hms}.000Z`, message: { role: 'user', content: text } });
const result = (hms, id, text = 'ok') => ({ type: 'user', timestamp: `2026-11-19T${hms}.000Z`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

function touch(path, at) {
  const t = new Date(at);
  utimesSync(path, t, t);
}

/**
 * Write the home into a temp dir; returns { dir, home, cfg (runs model), cleanup }. `mergeRuns` adds a
 * merge workflow ("release-train": Integrate > Verify > Fix > Review > Merge fix): a run that finished
 * at 11:00, and a running one verifying release 2.4.0.
 */
export function setupClaudeHome(overrides = {}, { mergeRuns = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-theater-home-'));
  const home = join(dir, '.claude');
  const session = join(home, 'projects', PROJECT, SESSION);
  const wf = join(session, 'subagents', 'workflows');
  const records = join(session, 'workflows');
  mkdirSync(join(records, 'scripts'), { recursive: true });
  const run = (id, journal, agents) => {
    mkdirSync(join(wf, id), { recursive: true });
    writeFileSync(join(wf, id, 'journal.jsonl'), lines([{ type: 'launched' }, ...journal]));
    for (const [agentId, rows, mtime] of agents) {
      const p = join(wf, id, `agent-${agentId}.jsonl`);
      writeFileSync(p, lines(rows));
      touch(p, mtime);
    }
    touch(join(wf, id, 'journal.jsonl'), Math.max(...agents.map((a) => a[2])));
  };
  const started = (agentId, label, phase) => ({ type: 'started', key: `k-${agentId}`, agentId, label, phase });
  const done = (agentId) => ({ type: 'result', key: `k-${agentId}`, agentId, result: { status: 'complete' } });

  // 1. a finished run (record: completed 11:50): Setup > Implement > Review > Ship
  run('wf_build-a1', [started('a1setup', 'setup', 'Setup'), done('a1setup'), started('a1impl', 'implement', 'Implement'), done('a1impl'), started('a1rev', 'review', 'Review'), done('a1rev'), started('a1ship', 'ship', 'Ship'), done('a1ship')], [
    ['a1setup', [use('10:00:00', 'u1', 'Bash', { command: 'git worktree add ../wt' })], ms('10:10:00')],
    ['a1impl', [use('10:10:00', 'u2', 'Edit', { file_path: '/home/dev/shop/src/cart.ts' })], ms('11:00:00')],
    ['a1rev', [use('11:00:00', 'u3', 'Read', { file_path: 'src/cart.ts' })], ms('11:30:00')],
    ['a1ship', [use('11:30:00', 'u4', 'Bash', { command: 'git merge feature' })], ms('11:50:00')],
  ]);
  writeFileSync(join(records, 'wf_build-a1.json'), JSON.stringify({ runId: 'wf_build-a1', workflowName: 'feature-build', status: 'completed', startTime: ms('10:00:00'), durationMs: 110 * 60_000, phases: [{ title: 'Setup' }, { title: 'Implement' }, { title: 'Review' }, { title: 'Ship' }], args: { title: 'Cart totals for dev@example.com' } }));

  // 2. a running run without a record, launched with an inline script (args.id BUG-42): Reproduce > Fix > Verify
  run('wf_fix-b2', [started('b2repro', 'reproduce', 'Reproduce'), done('b2repro'), started('b2fix', 'fix', 'Fix')], [
    ['b2repro', [use('11:20:00', 'u5', 'Bash', { command: 'pnpm vitest run cart' })], ms('11:40:00')],
    ['b2fix', [ask('11:40:00', 'Fix the rounding bug in the cart total. Questions to alice@example.com.'), use('11:40:00', 'u6', 'Edit', { file_path: 'src/cart.ts' }), say('11:58:50', 'Fixing the **cart total** rounding in /home/dev/shop/src/cart.ts. The token ghp_abcdefgh12345678 stays out of the logs.'), use('11:59:00', 'u7', 'Bash', { command: 'pnpm vitest run', run_in_background: true }), result('11:59:01', 'u7', 'Command running in background with ID: b1')], ms('11:59:01')],
  ]);

  // 3. a run stopped at 11:59 (record: killed); its agent never wrote a result: Draft > Review
  run('wf_docs-c3', [started('c3draft', 'draft', 'Draft')], [['c3draft', [use('11:30:00', 'u8', 'Write', { file_path: 'docs/guide.md' }), use('11:58:30', 'u9', 'Edit', { file_path: 'docs/guide.md' })], ms('11:58:30')]]);
  writeFileSync(join(records, 'wf_docs-c3.json'), JSON.stringify({ runId: 'wf_docs-c3', workflowName: 'docs-pass', status: 'killed', startTime: ms('11:30:00'), durationMs: 29 * 60_000, phases: [{ title: 'Draft' }, { title: 'Review' }] }));

  // 4. a running run known only by its persisted inline script (7 phases: the stage shows 6); it pushes
  run('wf_new-d4', [started('d4build', 'build', 'Build')], [['d4build', [use('11:45:00', 'u10', 'Edit', { file_path: 'src/a.ts' }), use('11:59:50', 'u11', 'Bash', { command: 'git push origin feature/x' })], ms('11:59:50')]]);
  writeFileSync(join(records, 'scripts', 'release-cut-wf_new-d4.js'), "export const meta = {\n  name: 'release-cut',\n  description: 'cut a release [with] brackets',\n  phases: [{ title: 'Setup', detail: 'a ] inside' }, { title: 'Build' }, { title: 'Test' }, { title: 'Review' }, { title: 'Fix' }, { title: 'Prep' }, { title: 'Publish' }],\n}\n");

  // 5. a run that ended yesterday: outside every window
  run('wf_old-e5', [started('e5old', 'implement', 'Implement'), done('e5old')], [['e5old', [use('09:00:00', 'u12', 'Edit', { file_path: 'x' })], ms('09:30:00', '18')]]);
  writeFileSync(join(records, 'wf_old-e5.json'), JSON.stringify({ runId: 'wf_old-e5', workflowName: 'old', status: 'completed', startTime: ms('09:00:00', '18'), durationMs: 30 * 60_000, phases: [{ title: 'Implement' }] }));

  if (mergeRuns) {
    const releaseScript = (id) => writeFileSync(join(records, 'scripts', `release-train-${id}.js`), "export const meta = {\n  name: 'release-train',\n  phases: [{ title: 'Integrate' }, { title: 'Verify' }, { title: 'Fix' }, { title: 'Review' }, { title: 'Merge fix' }],\n}\n");
    // 6. a merge run that integrated and finished at 11:00 (record: completed)
    run('wf_rel-f6', [started('f6int', 'integrate', 'Integrate'), done('f6int')], [['f6int', [use('10:40:00', 'u14', 'Bash', { command: 'git merge --no-ff agent/cart' })], ms('11:00:00')]]);
    writeFileSync(join(records, 'wf_rel-f6.json'), JSON.stringify({ runId: 'wf_rel-f6', workflowName: 'release-train', status: 'completed', startTime: ms('10:40:00'), durationMs: 20 * 60_000, phases: [{ title: 'Integrate' }, { title: 'Verify' }, { title: 'Fix' }, { title: 'Review' }, { title: 'Merge fix' }], args: { mode: 'integrate' } }));
    // 7. a merge run verifying release 2.4.0 now: its check runs in the background
    run('wf_rel-g7', [started('g7ver', 'verify 2.4.0', 'Verify')], [['g7ver', [use('11:50:00', 'u15', 'Bash', { command: 'git checkout release/2.4.0' }), use('11:59:30', 'u16', 'Bash', { command: 'pnpm run test:e2e', run_in_background: true }), result('11:59:31', 'u16', 'Command running in background with ID: b2')], ms('11:59:31')]]);
    releaseScript('wf_rel-g7');
  }

  // the session transcript: the launch of run 2 (its Workflow tool use and result)
  const script = "export const meta = { name: 'bugfix', phases: [{ title: 'Reproduce', detail: 'see [1]' }, { title: 'Fix' }, { title: 'Verify' }] }\nawait agent('x')";
  const transcript = `${session}.jsonl`;
  writeFileSync(transcript, lines([{ type: 'user', timestamp: '2026-11-19T11:19:00.000Z', cwd: '/home/dev/shop', message: { role: 'user', content: 'fix the cart bug' } }, use('11:19:30', 'toolu_w2', 'Workflow', { script, args: { id: 'BUG-42', title: 'Totals are wrong for dev@example.com' } }), result('11:19:31', 'toolu_w2', 'Workflow launched in background. Task ID: t1\nRun ID: wf_fix-b2\nTo resume...')]));
  touch(transcript, ms('11:59:55'));

  // a standalone subagent of the session
  const sub = join(session, 'subagents');
  writeFileSync(join(sub, 'agent-s1helper.jsonl'), lines([use('11:58:00', 'u13', 'Grep', { pattern: 'search' })]));
  writeFileSync(join(sub, 'agent-s1helper.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Research the docs search for dev@example.com' }));
  touch(join(sub, 'agent-s1helper.jsonl'), ms('11:58:00'));

  // an idle project (nothing since yesterday)
  const idle = join(home, 'projects', '-home-dev-idle', '2222bbbb-0000-4000-8000-000000000002');
  mkdirSync(join(idle, 'subagents', 'workflows', 'wf_idle-z9'), { recursive: true });
  writeFileSync(join(idle, 'subagents', 'workflows', 'wf_idle-z9', 'journal.jsonl'), lines([{ type: 'launched' }]));
  writeFileSync(`${idle}.jsonl`, '');
  for (const p of [join(idle, 'subagents', 'workflows', 'wf_idle-z9', 'journal.jsonl'), join(idle, 'subagents', 'workflows', 'wf_idle-z9'), join(idle, 'subagents', 'workflows'), join(idle, 'subagents'), `${idle}.jsonl`]) touch(p, ms('08:00:00', '17'));
  for (const p of [join(sub), wf, records]) touch(p, ms('11:59:00'));

  const cfg = normalizeConfig({ sources: { claude: home }, ...overrides }, dir);
  return { dir, home, cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
