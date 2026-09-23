/**
 * Offline benchmark: run the core on a converted Claude Code transcript (Message[] JSON).
 *   TYPESAFE_API_KEY=... npx -y tsx bench/run.mts messages.json [--no-jev] [--target 45]
 * Prints the stats the hook would toast, the pruned-context note, and every decision.
 */
import { readFileSync } from 'node:fs';
import { compactMessages, reductionRatio, type Message } from '../src/core.js';

const file = process.argv[2];
if (!file) { console.error('usage: run.mts messages.json [--no-jev] [--target N]'); process.exit(2); }
const noJev = process.argv.includes('--no-jev');
const ti = process.argv.indexOf('--target');
const targetPercent = ti > 0 ? Number(process.argv[ti + 1]) : 45;
const messages: Message[] = JSON.parse(readFileSync(file, 'utf8'));
const key = process.env['TYPESAFE_API_KEY'] ?? '';

const ask = async (state: string, questions: Record<string, { type: 'noul'; instructions: string }>) => {
  const res = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-1.13.0', state, questions }) });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { answers?: Record<string, { noul?: number }> };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(data.answers ?? {})) if (typeof v?.noul === 'number') out[k] = v.noul;
  return out;
};

const t0 = Date.now();
const r = await compactMessages(messages, { targetPercent, noJev: noJev || !key }, { ask, windowTokens: 200_000, now: new Date() });
const ms = Date.now() - t0;
const s = r.stats;
const acts = r.decisions.reduce<Record<string, number>>((a, d) => ((a[d.action] = (a[d.action] ?? 0) + 1), a), {});
console.log(JSON.stringify({ ms, reduction_pct: +(reductionRatio(r) * 100).toFixed(1), est_tokens: { before: Math.round(s.charsBefore / 4), after: Math.round(s.charsAfter / 4), target: Math.round(s.targetChars / 4) },
  under_target: s.underTarget, messages: `${s.messagesBefore}->${s.messagesAfter}`, by_kind: s.byKind, actions: acts, jev: { requests: s.jevRequests, candidates: s.jevCandidates, dropped: s.jevDropped }, noise_tokens: Math.round(s.noiseChars / 4) }, null, 1));
console.log('\nNOTE:', r.note || '(none)');
if (process.env['SHOW']) {
  console.log('\nJEV DECISIONS:');
  for (const d of r.decisions.filter((d) => d.p !== undefined).sort((a, b) => (b.p ?? 0) - (a.p ?? 0))) console.log(`  p=${d.p!.toFixed(2)} ${d.action.padEnd(12)} ${d.kind.padEnd(7)} ${d.chars.toString().padStart(6)}ch  ${d.head}`);
  console.log('\nRULE-KEPT (errors/tests):');
  for (const d of r.decisions.filter((d) => d.action === 'rule_kept')) console.log(`  ${d.kind.padEnd(7)} ${d.chars.toString().padStart(6)}ch  ${d.head}`);
}
