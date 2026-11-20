import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyLabel, classifyToolUse, displayHolder, jobFromSlug, parseOwner, privateText, publicPhrase, redact, safeLabel, KINDS, ROLES } from '../lib/classify.mjs';
import { RULES } from './helpers.mjs';

test('roles follow the workflow label (a preset\'s job rules)', () => {
  const cases = [
    ['S03-TASK-02 setup', 'setup', 'S03-TASK-02'],
    ['S03-TASK-02', 'coder', 'S03-TASK-02'],
    ['ITEM-STU-013', 'coder', 'ITEM-STU-013'],
    ['S03-TASK-02 review 1', 'reviewer', 'S03-TASK-02'],
    ['S03-TASK-02 fix 1', 'fixer', 'S03-TASK-02'],
    ['S03-TASK-02 prepare', 'preparer', 'S03-TASK-02'],
    ['S02-TASK-06 integrate', 'preparer', 'S02-TASK-06'],
    ['merge batch', 'merger', null],
    ['review:safety', 'verifier', null],
    ['verify:all', 'verifier', null],
    ['verify:logic', 'verifier', null],
    ['fix:queue', 'fixer', null],
    ['S01-GATE', 'verifier', 'S01-GATE'],
    ['build:server', 'coder', null],
    ['probe', 'helper', null],
    ['', 'helper', null],
  ];
  for (const [label, role, job] of cases) {
    const got = classifyLabel(label, RULES);
    assert.equal(got.role, role, label);
    assert.equal(got.job, job, label);
  }
});

test('tool uses map to action kinds', () => {
  const cases = [
    ['Edit', {}, 'edit'],
    ['Write', {}, 'edit'],
    ['Read', {}, 'read'],
    ['Grep', {}, 'search'],
    ['Glob', {}, 'search'],
    ['Bash', { command: 'pnpm vitest run' }, 'test'],
    ['Bash', { command: 'pnpm verify:full' }, 'test'],
    ['Bash', { command: 'pnpm test:e2e' }, 'test'],
    ['Bash', { command: 'docker compose up -d' }, 'docker'],
    ['Bash', { command: 'node scripts/chrome-journey.mjs' }, 'browser'],
    ['Bash', { command: 'git status --short' }, 'run'],
    ['Bash', { command: 'cat latest.txt' }, 'run'],
    ['PowerShell', { command: 'Get-ChildItem' }, 'run'],
    ['StructuredOutput', {}, 'think'],
    ['Monitor', {}, 'wait'],
  ];
  for (const [name, input, kind] of cases) assert.equal(classifyToolUse(name, input, RULES).kind, kind, `${name} ${input.command || ''}`);
});

test('a preset\'s lock and booth commands are recognised for the wait logic', () => {
  const lock = classifyToolUse('Bash', { command: 'bash tools/hold.sh acquire develop merge-batch', run_in_background: true }, RULES);
  assert.equal(lock.wait, 'lock');
  assert.equal(lock.lock, 'develop');
  assert.equal(lock.owner, 'merge-batch');
  assert.equal(lock.background, true);
  const slot = classifyToolUse('Bash', { command: 'bash tools/booth.sh run s04-task-02 pnpm ui:tour' }, RULES);
  assert.equal(slot.wait, 'slot');
  assert.equal(slot.kind, 'test');
  assert.equal(slot.detail, 'check');
  assert.equal(slot.owner, 's04-task-02');
  const exclusive = classifyToolUse('Bash', { command: 'booth.sh exclusive s01-gate pnpm verify:full --gate' }, RULES);
  assert.equal(exclusive.exclusive, true);
  assert.equal(exclusive.kind, 'test');
  assert.equal(classifyToolUse('Bash', { command: 'bash tools/hold.sh status' }, RULES).wait, undefined);
  // without a preset there are no booth or lock commands
  assert.equal(classifyToolUse('Bash', { command: 'bash tools/booth.sh run s04-task-02 pnpm ui:tour' }).wait, undefined);
  assert.equal(classifyToolUse('Bash', { command: 'bash tools/hold.sh acquire develop x' }).wait, undefined);
});

test('git pushes are marked on the tool use, dry runs are not', () => {
  assert.equal(classifyToolUse('Bash', { command: 'git push origin main' }).push, true);
  assert.equal(classifyToolUse('Bash', { command: 'git -C repo push --tags' }).push, true);
  assert.equal(classifyToolUse('Bash', { command: 'git push --dry-run' }).push, undefined);
  assert.equal(classifyToolUse('Bash', { command: 'git status' }).push, undefined);
});

test('public phrases are generic for every role and kind', () => {
  for (const kind of KINDS) {
    for (const role of ROLES) {
      const text = publicPhrase(kind, role, kind === 'wait' ? 'slot' : null);
      assert.match(text, /^[a-z][a-z -]+$/, `${kind}/${role}: ${text}`);
    }
  }
  assert.equal(publicPhrase('read', 'reviewer'), 'reviewing a change');
  assert.equal(publicPhrase('test', 'coder'), 'running tests');
  assert.equal(publicPhrase('wait', 'merger', 'lock'), 'waiting for the merge lock');
});

test('redaction removes e-mails, tokens and home paths', () => {
  const text = redact('push as dev@example.com with token=abc123 from C:/Users/someone/repo and /home/bob/x');
  assert.ok(!text.includes('example.com'));
  assert.ok(!text.includes('abc123'));
  assert.ok(!text.includes('someone'));
  assert.ok(!text.includes('bob'));
  assert.ok(redact('x'.repeat(200)).length <= 90);
  assert.equal(privateText('Read', { file_path: 'C:/Users/someone/project/src/a.ts' }), 'Read src/a.ts');
});

test('lock owners parse and display safely', () => {
  assert.deepEqual(parseOwner('s02-task-06 1795080240'), { holder: 's02-task-06', since: new Date(1795080240 * 1000).toISOString() });
  assert.equal(parseOwner('garbage'), null);
  assert.equal(displayHolder('s02-task-06', { publicMode: true, rules: RULES }), 'S02-TASK-06');
  assert.equal(displayHolder('some-hostname', { publicMode: true }), 'agent');
  assert.equal(displayHolder('image-tag', { publicMode: true, knownSlugs: new Set(['image-tag']) }), 'image-tag');
  assert.equal(displayHolder('merge-batch', { publicMode: true }), 'merge batch');
  assert.equal(jobFromSlug('agent/item-sec-018', RULES), 'ITEM-SEC-018');
  assert.equal(jobFromSlug('plan-14', RULES), null);
  assert.equal(jobFromSlug('agent/item-sec-018'), null);
  assert.equal(safeLabel('review:safety'), 'review:safety');
  assert.equal(safeLabel('C:/Users/x/run'), 'helper');
});
