/**
 * jev-compact — Claude Code function hook. Replaces the compaction step:
 *   rules prune exploration output and hook noise locally (nothing leaves the machine),
 *   Jev ranks only the remaining judgement calls against a context budget,
 *   a note tells the assistant what was removed, and the removed outputs are archived
 *   for the brain. Falls back to the built-in summary whenever it cannot do better.
 *
 * Config (plugin userConfig): targetPercent, compactAtPercent, preserveRecentMessages,
 * minReductionRatio, model, brainArchive. Key: TYPESAFE_API_KEY from the environment, else
 * read from ~/.env (the [personal] block). Opt-out: JEV_COMPACT_OFF=1, a `.jev-compact-off`
 * file in the working directory, or `[[jev:private]]` anywhere in the conversation — those
 * still get the local rule-based pruning, but nothing is sent to Jev.
 */
import type { On, PluginOptions, Register, SessionMessage } from 'claude-code';
import { compactMessages, mask, reductionRatio, type Message, type Result } from '../src/core.js';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

type Config = { targetPercent: number; compactAtPercent: number; preserveRecentMessages: number; minReductionRatio: number; model: string; brainArchive: boolean };

function num(o: PluginOptions, k: string, d: number): number { const v = o[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function str(o: PluginOptions, k: string, d: string): string { const v = o[k]; return typeof v === 'string' && v ? v : d; }
function bool(o: PluginOptions, k: string, d: boolean): boolean { const v = o[k]; return typeof v === 'boolean' ? v : d; }

export function resolveConfig(o: PluginOptions): Config {
  return { targetPercent: num(o, 'targetPercent', 45), compactAtPercent: num(o, 'compactAtPercent', 75),
           preserveRecentMessages: num(o, 'preserveRecentMessages', 12), minReductionRatio: num(o, 'minReductionRatio', 0.25),
           model: str(o, 'model', 'jev-1.13.0'), brainArchive: bool(o, 'brainArchive', true) };
}

/** TYPESAFE_API_KEY from the process, else the first such line in ~/.env. Never logged. */
async function apiKey($: any): Promise<string | undefined> {
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const home = (await $.env.get('HOME')) ?? '';
  try {
    const text: string = await $.fs.read(`${home}/.env`);
    const m = text.match(/^\s*TYPESAFE_API_KEY\s*=\s*"?([^"\n]+)"?\s*$/m);
    return m?.[1]?.trim();
  } catch { return undefined; }
}

async function optedOut($: any, messages: readonly SessionMessage[]): Promise<string | null> {
  if ((await $.env.get('JEV_COMPACT_OFF')) === '1') return 'JEV_COMPACT_OFF=1';
  if (await $.fs.exists('.jev-compact-off')) return '.jev-compact-off present';
  if (messages.some((m) => m.text.includes('[[jev:private]]'))) return '[[jev:private]] marker';
  return null;
}

function asker($: any, key: string, model: string) {
  return async (state: string, questions: Record<string, { type: 'noul'; instructions: string }>) => {
    const res = await $.http.fetch(JEV_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                                             body: JSON.stringify({ model, state, questions }) });
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}`);
    const data = JSON.parse(res.text) as { answers?: Record<string, { noul?: number }> };
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(data.answers ?? {})) if (typeof v?.noul === 'number') out[k] = v.noul;
    return out;
  };
}

/** Same objects back where nothing changed (handle intact); rebuilt messages carry no handle. */
function toSession(input: readonly SessionMessage[], output: readonly Message[]): SessionMessage[] {
  const own = new Set<Message>(input as readonly Message[]);
  return output.map((m) => (own.has(m) ? (m as SessionMessage) : { role: m.role, text: m.text, toolUses: m.toolUses as SessionMessage['toolUses'], ...(m.toolResults ? { toolResults: m.toolResults as SessionMessage['toolResults'] } : {}) }));
}

async function appendLog($: any, line: string): Promise<void> {
  try {
    const home = (await $.env.get('HOME')) ?? '';
    const p = `${home}/.local/state/jev/compact.log`;
    let prev = '';
    try { prev = await $.fs.read(p); } catch { /* first write */ }
    if (prev.length > 200_000) prev = prev.slice(-100_000);
    await $.fs.write(p, `${prev}${new Date().toISOString().slice(0, 19)} ${line}\n`);
  } catch { /* logging is best-effort */ }
}

async function archive($: any, result: Result, agentId: string | undefined): Promise<void> {
  if (result.dropped.length === 0) return;
  try {
    const home = (await $.env.get('HOME')) ?? '';
    const d = new Date().toISOString();
    const path = `${home}/brain/archive/compaction/${d.slice(0, 10)}/${agentId ?? 'main'}-${d.slice(11, 19).replace(/:/g, '')}.jsonl`;
    const lines = result.dropped.map((x) => JSON.stringify({ tool: x.tool, input: x.input, result: x.result.slice(0, 20_000) }));
    let text = lines.join('\n') + '\n';
    if (text.length > 2_000_000) text = text.slice(0, 2_000_000);
    await $.fs.write(path, text);
  } catch { /* archive is best-effort */ }
}

function summary(r: Result): string {
  const s = r.stats;
  const pct = Math.round(reductionRatio(r) * 100);
  const acts = r.decisions.reduce<Record<string, number>>((a, d) => ((a[d.action] = (a[d.action] ?? 0) + 1), a), {});
  const kinds = Object.entries(s.byKind).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
  return `${pct}% smaller (${Math.round(s.charsBefore / 4 / 1000)}k→${Math.round(s.charsAfter / 4 / 1000)}k est. tokens, target ${Math.round(s.targetChars / 4 / 1000)}k) · ` +
         `pruned ${acts['result_pruned'] ?? 0} exploration, ${acts['jev_dropped'] ?? 0}/${s.jevCandidates} judgement calls, ${Math.round(s.noiseChars / 4)} tok noise · kept ${acts['rule_kept'] ?? 0} errors/tests · ${s.jevRequests} Jev req · calls: ${kinds}`;
}

export const register: Register = (on: On, options: PluginOptions) => {
  const cfg = resolveConfig(options);
  let compacting = false;

  on('session.compact', async ($: any, event: any, next: any) => {
    if (event.trigger === 'precompute') return next(event);
    try {
      const reason = await optedOut($, event.messages);
      const key = reason ? undefined : await apiKey($);
      const usage = await $.session.usage();
      const windowTokens = usage?.context?.window ?? 200_000;
      const tokens = usage?.context?.tokens;
      const charsPerToken = tokens ? Math.min(5, Math.max(3, event.messages.reduce((n: number, m: SessionMessage) => n + m.text.length + JSON.stringify(m.toolUses).length + JSON.stringify(m.toolResults ?? []).length, 0) / tokens)) : 4;
      const result = await compactMessages(event.messages as Message[], { preserveRecentMessages: cfg.preserveRecentMessages, targetPercent: cfg.targetPercent, minReductionRatio: cfg.minReductionRatio, charsPerToken, noJev: !key },
                                           { ask: key ? asker($, key, cfg.model) : async () => ({}), windowTokens, now: new Date() });
      const ratio = reductionRatio(result);
      const line = summary(result) + (reason ? ` · Jev skipped (${reason})` : key ? '' : ' · Jev skipped (no key)');
      if (cfg.brainArchive) await archive($, result, event.agentId);
      const messages = toSession(event.messages, result.messages);
      if (ratio < cfg.minReductionRatio || !result.stats.underTarget) {
        // Pruning alone is not enough: let the built-in summary work on the pruned set, which is
        // never worse than summarising the raw one (less noise in, same text out).
        $.ui.toast(`jev-compact: ${line} · summarising the rest`, { timeoutMs: 12_000 });
        await appendLog($, `hybrid ${line}`);
        return next({ ...event, messages });
      }
      $.ui.toast(`jev-compact: ${line}`, { timeoutMs: 12_000 });
      $.ui.log(`jev-compact: ${line}`);
      await appendLog($, `pruned ${line}`);
      return { messages };
    } catch (error) {
      const msg = mask(error instanceof Error ? error.message : String(error));
      $.ui.log(`jev-compact: fallback to built-in summary (${msg})`);
      await appendLog($, `error ${msg}`);
      return next(event);
    }
  });

  on('turn.complete', async ($: any, event: any, next: any) => {
    try {
      const { context } = await $.session.usage();
      const pct = context?.percent ?? 0;
      if (await $.env.get('JEV_COMPACT_DEBUG')) await appendLog($, `turn ${event.reason} ${pct}% of ${context?.window ?? '?'} (threshold ${cfg.compactAtPercent}%)`);
      if (!compacting && event.reason === 'answer' && pct >= cfg.compactAtPercent) {
        compacting = true;
        // $.session.compact() rejects while a turn runs, and turn.complete still sits inside the
        // turn, so the call is deferred to a timer that fires once the session is idle. If a new
        // turn has started by then it rejects, is logged, and the next turn.complete tries again.
        $.clock.after(1000, () => {
          void (async () => {
            try {
              const r = await $.session.compact();
              await appendLog($, `auto ${pct}% >= ${cfg.compactAtPercent}% -> ${r && typeof r === 'object' && 'skip' in r ? `skipped (${(r as { skip: string }).skip})` : 'compacted'}`);
            } catch (error) {
              await appendLog($, `auto ${pct}% failed: ${mask(error instanceof Error ? error.message : String(error))}`);
            } finally {
              compacting = false;
            }
          })();
        });
      }
    } catch (error) {
      await appendLog($, `auto-compact check failed: ${mask(error instanceof Error ? error.message : String(error))}`);
    }
    return next(event);
  });
};
