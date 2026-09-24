/**
 * jev-compact-trigger — after every answered turn, read the context fill and start a
 * compaction once it passes the threshold. Lives in its own plugin because the engine skips a
 * plugin's own `session.compact` hook when that plugin raised the compaction (re-entry rule):
 * raised from here, jev-compact's pruning hook runs as it does for a typed `/compact`.
 *
 * `$.session.compact()` rejects while a turn runs and `turn.complete` still sits inside the
 * turn, so the call is deferred to a short timer; if a new turn started meanwhile it rejects,
 * the failure is logged, and the next turn.complete tries again. Threshold: jev-compact's
 * `compactAtPercent` config row when present (one knob for both plugins), else this plugin's
 * own, else 75. Log: ~/.local/state/jev/compact.log. JEV_COMPACT_DEBUG=1 logs every turn.
 */
import type { On, PluginOptions, Register } from 'claude-code';

const DEFAULT_AT = 75;
const DEFER_MS = 1000;

function mask(text: string): string {
  return text.replace(/(bearer\s+)[A-Za-z0-9._\-]{12,}/gi, '$1<redacted>').replace(/\bapikey_[0-9a-f]{20,}[0-9a-f_]*/g, '<redacted>');
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

async function threshold($: any, options: PluginOptions): Promise<number> {
  try {
    const rows: Array<{ key: string; value: unknown }> = await $.config.list();
    const v = Number(rows.find((r) => r.key === 'jev-compact.compactAtPercent')?.value);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* fall through to our own option */ }
  const own = Number(options['compactAtPercent']);
  return Number.isFinite(own) && own > 0 ? own : DEFAULT_AT;
}

export const register: Register = (on: On, options: PluginOptions) => {
  let pending = false;

  on('turn.complete', async ($: any, event: any, next: any) => {
    try {
      const { context } = await $.session.usage();
      const pct = context?.percent ?? 0;
      const at = await threshold($, options);
      if (await $.env.get('JEV_COMPACT_DEBUG')) await appendLog($, `turn ${event.reason} ${pct}% of ${context?.window ?? '?'} (threshold ${at}%)`);
      if (!pending && event.reason === 'answer' && pct >= at) {
        pending = true;
        $.clock.after(DEFER_MS, () => {
          void (async () => {
            try {
              const r = await $.session.compact();
              const skipped = r && typeof r === 'object' && 'skip' in r ? (r as { skip: string }).skip : null;
              await appendLog($, `auto ${pct}% >= ${at}% -> ${skipped ? `skipped (${skipped})` : 'compacted'}`);
            } catch (error) {
              await appendLog($, `auto ${pct}% >= ${at}% failed: ${mask(error instanceof Error ? error.message : String(error))}`);
            } finally {
              pending = false;
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
