import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, compactMessages, mask, reductionRatio, sizeOf, stripNoise, type Message } from '../src/core.js';

let n = 0;
const call = (tool: string, input: Record<string, unknown>, output: string, isError = false): Message[] => {
  const id = `t${++n}`;
  return [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input, text: output, isError }] },
          { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: output, isError }] }];
};
const user = (text: string): Message => ({ role: 'user', text, toolUses: [] });
const asst = (text: string): Message => ({ role: 'assistant', text, toolUses: [] });
const big = (s: string, k = 3000) => s.repeat(Math.ceil(k / s.length)).slice(0, k);
const ctx = (answers: Record<string, number> = {}, windowTokens = 200_000) => ({ ask: async () => answers, windowTokens, now: new Date('2026-09-23T10:00:00Z') });

test('classification', () => {
  assert.equal(classify('Read', { file_path: 'a' }), 'explore');
  assert.equal(classify('Edit', {}), 'mutate');
  assert.equal(classify('Bash', { command: 'git status && git log --oneline | head' }), 'explore');
  assert.equal(classify('Bash', { command: 'npx vitest run src/x.test.ts' }), 'verify');
  assert.equal(classify('Bash', { command: 'git commit -m x && git push origin dev' }), 'mutate');
  assert.equal(classify('Bash', { command: 'agent-browser --session q snapshot -i' }), 'explore');
  assert.equal(classify('Bash', { command: 'jab check "logged in"' }), 'verify');
  assert.equal(classify('mcp__plugin_slack_slack__slack_read_channel', {}), 'explore');
  assert.equal(classify('mcp__plugin_slack_slack__slack_send_message', {}), 'mutate');
  assert.equal(classify('Agent', {}), 'agent');
});

test('noise stripping keeps the user words', () => {
  const { text, removed } = stripNoise('fix the bug\n<system-reminder>internal stuff</system-reminder>\n\nPostToolUse:Bash hook additional context: scanned\nmore lines\n\nthanks');
  assert.ok(removed > 0);
  assert.ok(text.includes('fix the bug') && text.includes('thanks'));
  assert.ok(!text.includes('internal stuff') && !text.includes('scanned'));
});

test('masking', () => {
  const m = mask('Authorization: Bearer abcdefghijklmnop123 and TYPESAFE_API_KEY=apikey_0000fake0000fake0000fake00 postgres://u:hunter2secret@h/db');
  assert.ok(!m.includes('abcdefghijklmnop123') && !m.includes('293b3687') && !m.includes('hunter2secret'));
});

test('exploration output is pruned without Jev; edits and errors are kept; recent messages untouched', async () => {
  const msgs: Message[] = [user('fix the parser'), ...call('Read', { file_path: 'a.ts' }, big('line of code\n')), ...call('Grep', { pattern: 'x' }, big('match\n')),
    ...call('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, 'The file has been updated.'),
    ...call('Bash', { command: 'npx vitest run' }, 'FAIL a.test.ts\n  Expected true\n  Received false\n' + big('trace\n'), true),
    asst('fixing'), ...call('Bash', { command: 'npx vitest run' }, big('PASS a.test.ts ✓\n')), asst('done'), user('now add a changelog')];
  const r = await compactMessages(msgs, { preserveRecentMessages: 2, targetPercent: 45 }, ctx());
  const acts = Object.fromEntries(r.decisions.map((d) => [d.head.split(' ')[0] + ':' + d.chars, d.action]));
  assert.ok(r.stats.jevRequests <= 1);                       // at most the one passing test run goes to Jev
  assert.ok(!r.decisions.some((d) => d.kind === 'explore' && d.p !== undefined));  // exploration never asks Jev
  assert.ok(r.decisions.some((d) => d.tool === 'Read' && d.action === 'result_pruned'));
  assert.ok(r.decisions.some((d) => d.tool === 'Grep' && d.action === 'result_pruned'));
  assert.ok(r.decisions.some((d) => d.tool === 'Edit' && d.action === 'kept'));
  assert.ok(r.decisions.some((d) => d.kind === 'verify' && d.action === 'rule_kept'), JSON.stringify(acts));
  assert.ok(r.messages[1]!.text.startsWith('[jev-compact'));  // the note sits after the task
  assert.ok(r.messages.at(-1)!.text === 'now add a changelog');
  assert.ok(reductionRatio(r) > 0.5);
  assert.ok(r.dropped.length >= 2);
});

test('above target, Jev ranks candidates and the lowest go first until under budget', async () => {
  const msgs: Message[] = [user('task'), ...call('Agent', { prompt: 'research A' }, big('report A\n', 8000)), ...call('Agent', { prompt: 'research B' }, big('report B\n', 8000)),
    ...call('Bash', { command: 'npm test' }, big('PASS\n', 8000)), asst('ok'), user('continue')];
  const before = sizeOf(msgs);
  // window tiny so we are above target; answers: A important, B not, test run not
  const r = await compactMessages(msgs, { preserveRecentMessages: 2, targetPercent: 45 }, ctx({ c1: 0.9, c2: 0.1, c3: 0.2 }, Math.round(before / 4 * 0.6)));
  assert.equal(r.stats.jevRequests, 1);
  const byId = Object.fromEntries(r.decisions.map((d) => [d.id, d.action]));
  assert.equal(byId['c2'], 'jev_dropped');
  assert.equal(byId['c3'], 'jev_dropped');
  assert.ok(byId['c1'] === 'jev_kept' || byId['c1'] === 'jev_dropped');
  assert.ok(r.note.includes('pruned'));
});

test('no-Jev mode never asks and still prunes exploration', async () => {
  const msgs: Message[] = [user('task'), ...call('Read', { file_path: 'x' }, big('l\n')), ...call('Agent', { prompt: 'p' }, big('r\n', 9000)), user('go')];
  let asked = false;
  const r = await compactMessages(msgs, { preserveRecentMessages: 1, noJev: true }, { ask: async () => { asked = true; return {}; }, windowTokens: 100, now: new Date() });
  assert.equal(asked, false);
  assert.ok(r.decisions.some((d) => d.tool === 'Read' && d.action === 'result_pruned'));
  assert.ok(r.decisions.some((d) => d.tool === 'Agent' && d.action === 'kept'));
});

test('large old inputs are shortened, pinned ones are not', async () => {
  const script = 'python3 - <<EOF\n' + 'x = 1\n'.repeat(900) + 'EOF';
  const msgs: Message[] = [user('task'), ...call('Bash', { command: script }, 'ok'), asst('ran it'), ...call('Bash', { command: script }, 'ok'), user('go')];
  const r = await compactMessages(msgs, { preserveRecentMessages: 3 }, ctx());
  const old = r.messages[2]!.toolUses[0]!.input['command'] as string;           // index 2: the note sits at 1
  const recent = r.messages.at(-3)!.toolUses[0]!.input['command'] as string;
  assert.ok(old.length < 800 && old.includes('chars of script omitted'));
  assert.equal(recent, script);
  assert.ok(r.note.includes('shortened'));
});

test('unchanged messages are the same objects (handles survive)', async () => {
  const msgs: Message[] = [user('task'), asst('thinking'), ...call('Read', { file_path: 'x' }, big('l\n')), user('go')];
  const r = await compactMessages(msgs, { preserveRecentMessages: 1 }, ctx());
  assert.equal(r.messages[0], msgs[0]);
  assert.equal(r.messages.at(-1), msgs.at(-1));
});
