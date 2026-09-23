/**
 * jev-compact core: rule-based pruning first, Jev only for the calls that need judgement,
 * a budget instead of a fixed threshold, and a note that says what was removed.
 *
 * Pure: no engine, no fs, no network. The hook and the offline bench both drive it through
 * `compactMessages(messages, options, ctx)`.
 */

export type Role = 'user' | 'assistant';
export interface ToolUse { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string; isError?: boolean }
export interface ToolResult { tool_use_id: string; text: string; isError?: boolean }
export interface Message { role: Role; text: string; toolUses: ToolUse[]; toolResults?: ToolResult[]; handle?: string }

export type Kind = 'explore' | 'mutate' | 'verify' | 'agent' | 'other';
export type Action = 'pinned' | 'kept' | 'result_pruned' | 'result_truncated' | 'jev_dropped' | 'jev_kept' | 'rule_kept';
export const INPUT_KEEP = 600;  // chars of a tool input kept verbatim on older calls

export interface Decision { id: string; tool: string; kind: Kind; action: Action; chars: number; p?: number; head: string; inputTrimmed?: number }

export interface Options {
  /** Newest messages never touched. */
  preserveRecentMessages: number;
  /** Context share to prune down to, as a percentage of the window (chars, estimated). */
  targetPercent: number;
  /** Below this estimated char reduction the built-in summary runs instead. */
  minReductionRatio: number;
  /** Chars of a pruned/truncated result kept as a stub. */
  stubChars: number;
  /** Estimated chars per token, used to turn the token window into a char budget. */
  charsPerToken: number;
  /** Do not send anything to Jev (rules only). */
  noJev: boolean;
}

export const DEFAULTS: Options = {
  preserveRecentMessages: 12, targetPercent: 45, minReductionRatio: 0.25, stubChars: 200, charsPerToken: 4, noJev: false,
};

export interface Ctx {
  /** Ask Jev: returns the noul probability per question name. */
  ask: (state: string, questions: Record<string, { type: 'noul'; instructions: string }>) => Promise<Record<string, number>>;
  /** Context window in tokens, from $.session.usage(). */
  windowTokens: number;
  now: Date;
}

export interface Result {
  messages: Message[];
  decisions: Decision[];
  dropped: Array<{ tool: string; input: Record<string, unknown>; result: string }>;
  note: string;
  stats: { charsBefore: number; charsAfter: number; targetChars: number; messagesBefore: number; messagesAfter: number;
           byKind: Record<Kind, number>; jevRequests: number; jevCandidates: number; jevDropped: number; noiseChars: number; underTarget: boolean };
}

// ---------------------------------------------------------------- classification

const EXPLORE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'NotebookRead', 'TodoRead',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'LSP']);
const MUTATE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task', 'Workflow']);

// Anything that can change state. Everything else in Bash is treated as exploration: on real
// transcripts commands are compound (`cd x; grep …`), so an allowlist of read-only verbs misses them.
const BASH_WRITEISH = /(>|>>|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\bchmod\b|\bchown\b|\btee\b|\bsed -i|\btouch\b|\bln\b|\binstall\b|\bgit (commit|push|merge|rebase|reset|checkout|switch|restore|stash|branch -[dD]|tag|am|apply|cherry-pick|revert|clean)\b|\bnpm (i|install|ci|publish|run|start)\b|\bpnpm\b|\byarn\b|\bpip3? install\b|\buv (tool|pip|add)\b|\bbrew (install|uninstall)\b|\blaunchctl\b|\bscp\b|\brsync\b|\bssh\b|\bcurl\b.*(-X (POST|PUT|PATCH|DELETE)|-d |--data)|\bpython3? -\b|\bpython3? [^-\s]|\bnode -e\b|\bnode [^-\s]|\bosascript\b|\bkill|\bpbcopy\b|\bgh (pr (create|merge|edit|close|ready|comment)|issue (create|comment|close)|api .*-f |repo (edit|create|delete))|\bagent-browser [a-z-]* ?(open|click|fill|type|press|select|close|record|cookies|upload|download|navigate)|\bjab (click|fill|select|do)|\bhunch\b|\bjev-replicate\b|\bwith-env\b.*\b(sh -c|python|node)|\bdefaults write|\bsecurity\b)/;
const BASH_VERIFY = /(\bvitest\b|\bjest\b|\bpytest\b|\bnpm (run )?test\b|\bpnpm test\b|\byarn test\b|\btsc\b|\beslint\b|\bruff\b|\bmypy\b|\bgo test\b|\bcargo test\b|\bmake test\b|unittest|\bnpm run build\b|\bnext build\b|\bjab check\b|\bcurl\b.*-w ['"]?%\{http_code|\bgh pr checks\b|\bgh run (view|watch)\b|--dry-run|\bbash -n\b|\bplutil -lint\b|python3? -m py_compile)/;
const ERRORISH = /(\bFAIL(ED)?\b|\bError\b|error:|Traceback|Exception|✗|✘|exit code [1-9]|command not found|Permission denied|ENOENT|ETIMEDOUT|rc=[1-9])/;

export function classify(tool: string, input: Record<string, unknown>): Kind {
  if (EXPLORE_TOOLS.has(tool)) return 'explore';
  if (MUTATE_TOOLS.has(tool)) return 'mutate';
  if (AGENT_TOOLS.has(tool)) return 'agent';
  if (tool === 'Bash') {
    const cmd = String(input['command'] ?? '');
    if (BASH_VERIFY.test(cmd)) return 'verify';
    // `2>/dev/null`, `2>&1` and `>/dev/null` are not writes
    const scrubbed = cmd.replace(/\d?>&?\s*\/dev\/null|2>&1|>\s*\/dev\/null/g, ' ');
    return BASH_WRITEISH.test(scrubbed) ? 'mutate' : 'explore';
  }
  if (tool.startsWith('mcp__')) {
    const name = tool.split('__').pop() ?? '';
    if (/(^|_)(get|list|read|search|fetch|query|describe|snapshot|find|screenshot|tabs_context|read_page|get_page_text|stats|resolve|explore)/.test(name)) return 'explore';
    if (/(^|_)(send|create|update|delete|write|post|add|remove|move|set|publish|complete|upload|change|run|invoke|execute|navigate|form_input|computer|click|type|schedule|react|import|manage|start|stop|cancel|buy)/.test(name)) return 'mutate';
    return 'other';
  }
  return 'other';
}

// ---------------------------------------------------------------- helpers

export function mask(text: string): string {
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._\-]{12,}/gi, '$1<redacted>')
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, '<redacted>')
    .replace(/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, '<redacted>')
    .replace(/\bapikey_[0-9a-f]{20,}[0-9a-f_]*/g, '<redacted>')
    .replace(/\bsk-[A-Za-z0-9\-_]{20,}/g, '<redacted>')
    .replace(/\bxox[abp]-[A-Za-z0-9\-]{10,}/g, '<redacted>')
    .replace(/\b([A-Z0-9_]*(?:secret|token|password|passwd|api_key|apikey)[A-Z0-9_]*)(\s*[=:]\s*)(['"]?)[^\s'"]{6,}\3/gi, '$1$2<redacted>')
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi, '$1<redacted>$2');
}

/** Hook/system noise in an older user message: system reminders, persisted output, hook banners. */
export function stripNoise(text: string): { text: string; removed: number } {
  const before = text.length;
  let out = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<persisted-output>[\s\S]*?<\/persisted-output>/g, '[persisted output omitted]')
    .replace(/^(PostToolUse|PreToolUse|SessionStart|UserPromptSubmit):[^\n]*hook[^\n]*\n(?:(?!\n\n)[\s\S])*?(?=\n\n|$)/gm, '[hook output omitted]')
    .replace(/^\[Request interrupted by user[^\]]*\]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: out, removed: before - out.length };
}

function inputHead(input: Record<string, unknown>, n = 90): string {
  let s = String(input['command'] ?? input['file_path'] ?? input['pattern'] ?? input['url'] ?? input['description'] ?? input['prompt'] ?? JSON.stringify(input));
  if (input['command'] !== undefined) {
    // show the meaningful part: drop leading `cd …;`, variable assignments and function definitions
    s = s.replace(/^(\s*(cd\s+\S+|export\s+\S+|[A-Za-z_][A-Za-z0-9_]*=\S+|[a-z_]+\(\)\s*\{[^}]*\})\s*(;|&&)?\s*)+/, '');
  }
  return s.replace(/\s+/g, ' ').slice(0, n);
}

function trimInput(tool: string, input: Record<string, unknown>): { input: Record<string, unknown>; saved: number } | null {
  let saved = 0;
  const out: Record<string, unknown> = { ...input };
  const cut = (key: string, keep: number, note: string) => {
    const v = out[key];
    if (typeof v === 'string' && v.length > keep + 80) { saved += v.length - keep - note.length; out[key] = `${v.slice(0, keep)}\n[… ${v.length - keep} chars ${note}]`; }
  };
  if (tool === 'Write') cut('content', 300, 'written to the file on disk — read it if needed');
  else if (tool === 'Edit' || tool === 'MultiEdit') { cut('old_string', 300, 'omitted — the edit is applied on disk'); cut('new_string', 400, 'omitted — the edit is applied on disk'); }
  else if (tool === 'Bash') cut('command', INPUT_KEEP, 'of script omitted — its effect is in the result and the assistant text');
  else for (const k of Object.keys(out)) cut(k, 800, 'omitted');
  return saved > 0 ? { input: out, saved } : null;
}

function headTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 20) return text;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`;
}

export function sizeOf(messages: readonly Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += m.text.length;
    for (const u of m.toolUses) n += JSON.stringify(u.input).length + 40;
    for (const r of m.toolResults ?? []) n += r.text.length + 20;
  }
  return n;
}

// ---------------------------------------------------------------- the pass

interface Cand { id: string; tool: string; kind: Kind; mi: number; ri: number; input: Record<string, unknown>; result: ToolResult; evidence: string }

export async function compactMessages(input: readonly Message[], options: Partial<Options>, ctx: Ctx): Promise<Result> {
  const opt: Options = { ...DEFAULTS, ...options };
  const messages: Message[] = input.map((m) => m);           // same objects until we rebuild one
  const rebuilt = new Set<number>();
  const charsBefore = sizeOf(messages);
  // Budget: the configured share of the window, but a compaction always cuts at least ~45% of
  // what is there — otherwise a manual /compact at 50% context would trim 5% and change nothing.
  const targetChars = Math.min(Math.floor(ctx.windowTokens * (opt.targetPercent / 100) * opt.charsPerToken), Math.floor(charsBefore * 0.55));
  const pinnedFrom = Math.max(1, messages.length - opt.preserveRecentMessages);
  const decisions: Decision[] = [];
  const dropped: Result['dropped'] = [];
  const byKind: Record<Kind, number> = { explore: 0, mutate: 0, verify: 0, agent: 0, other: 0 };
  let noiseChars = 0;

  // result lookup: tool_use_id -> (message index, result index)
  const where = new Map<string, { mi: number; ri: number }>();
  messages.forEach((m, mi) => (m.toolResults ?? []).forEach((r, ri) => where.set(r.tool_use_id, { mi, ri })));

  const setResult = (mi: number, ri: number, text: string) => {
    const m = messages[mi]!;
    const results = (m.toolResults ?? []).map((r, i) => (i === ri ? { ...r, text } : r));
    messages[mi] = { role: m.role, text: m.text, toolUses: m.toolUses, toolResults: results };
    rebuilt.add(mi);
  };
  const setInput = (mi: number, ui: number, input: Record<string, unknown>) => {
    const m = messages[mi]!;
    const uses = m.toolUses.map((u, i) => (i === ui ? { ...u, input } : u));
    const next: Message = { role: m.role, text: m.text, toolUses: uses };
    if (m.toolResults) next.toolResults = m.toolResults;
    messages[mi] = next;
    rebuilt.add(mi);
  };
  const setText = (mi: number, text: string) => {
    const m = messages[mi]!;
    const next: Message = { role: m.role, text, toolUses: m.toolUses };
    if (m.toolResults) next.toolResults = m.toolResults;
    messages[mi] = next;
    rebuilt.add(mi);
  };

  // 1. noise out of older user text
  for (let mi = 1; mi < pinnedFrom; mi++) {
    const m = messages[mi]!;
    if (m.role === 'user' && m.text) {
      const { text, removed } = stripNoise(m.text);
      if (removed > 0) { noiseChars += removed; setText(mi, text); }
    }
  }

  // 2. rules per tool call
  const candidates: Cand[] = [];
  let n = 0;
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi]!;
    if (m.role !== 'assistant') continue;
    for (let ui = 0; ui < m.toolUses.length; ui++) {
      const u = m.toolUses[ui]!;
      const id = `c${++n}`;
      const loc = where.get(u.tool_use_id);
      const result = loc ? messages[loc.mi]!.toolResults![loc.ri]! : undefined;
      const chars = result?.text.length ?? 0;
      const kind = classify(u.tool, u.input);
      byKind[kind]++;
      const head = `${u.tool} ${inputHead(u.input)}`;
      const pinned = mi === 0 || mi >= pinnedFrom || !loc || loc.mi >= pinnedFrom;
      if (pinned || !result) { decisions.push({ id, tool: u.tool, kind, action: 'pinned', chars, head }); continue; }
      // Large inputs of older calls (heredoc scripts, Write contents, big Edit strings) are the bulk of
      // real transcripts. The effect is on disk and in the assistant's text; keep a head only.
      const trimmed = trimInput(u.tool, u.input);
      if (trimmed) setInput(mi, ui, trimmed.input);
      const inputTrimmed = trimmed?.saved;
      const isErr = result.isError || u.isError || (kind === 'verify' && ERRORISH.test(result.text.slice(0, 4000)));
      if (kind === 'explore') {
        if (chars > opt.stubChars) {
          dropped.push({ tool: u.tool, input: u.input, result: result.text });
          setResult(loc.mi, loc.ri, `[pruned ${chars} chars of ${u.tool} output — re-run if needed] ${result.text.slice(0, 120).replace(/\s+/g, ' ')}`);
          decisions.push({ id, tool: u.tool, kind, action: 'result_pruned', chars, head, inputTrimmed });
        } else decisions.push({ id, tool: u.tool, kind, action: 'kept', chars, head, inputTrimmed });
      } else if (kind === 'mutate') {
        if (chars > opt.stubChars) {
          setResult(loc.mi, loc.ri, headTail(result.text, opt.stubChars, 0));
          decisions.push({ id, tool: u.tool, kind, action: 'result_truncated', chars, head, inputTrimmed });
        } else decisions.push({ id, tool: u.tool, kind, action: 'kept', chars, head, inputTrimmed });
      } else if (isErr) {
        if (chars > 4000) setResult(loc.mi, loc.ri, headTail(result.text, 2500, 1200));
        decisions.push({ id, tool: u.tool, kind, action: 'rule_kept', chars, head, inputTrimmed });
      } else if (chars <= opt.stubChars * 3) {
        decisions.push({ id, tool: u.tool, kind, action: 'kept', chars, head, inputTrimmed });
      } else {
        candidates.push({ id, tool: u.tool, kind, mi: loc.mi, ri: loc.ri, input: u.input, result,
          evidence: headTail(result.text, kind === 'agent' ? 700 : 350, 350) });
      }
    }
  }

  // 3. budget: only if still above target do we ask Jev about the remaining candidates
  let jevRequests = 0, jevDropped = 0;
  let after = sizeOf(messages);
  if (after > targetChars && candidates.length > 0 && !opt.noJev) {
    const goal = messages[0]!.text.slice(0, 1500);
    const latest = [...messages].reverse().find((m) => m.role === 'user' && m.text.trim())?.text.slice(0, 800) ?? '';
    const recent = messages.slice(-8).filter((m) => m.role === 'assistant' && m.text.trim()).map((m) => m.text.slice(0, 300)).join('\n---\n');
    const scores = new Map<string, number>();
    for (let i = 0; i < candidates.length; i += 30) {
      const batch = candidates.slice(i, i + 30);
      const state = mask([
        'A coding assistant conversation is being compacted. TASK is what the user originally asked; LATEST is the newest user message; RECENT is what the assistant said last. Each CALL below is an older tool call whose full output is a candidate for deletion. The assistant can always re-run a tool; deleting is only wrong when the exact output is still needed to finish the current work.',
        `TASK: ${goal}`, `LATEST: ${latest}`, `RECENT:\n${recent}`,
        ...batch.map((c) => `CALL ${c.id} [${c.kind}] ${c.tool} ${inputHead(c.input, 200)}\nOUTPUT:\n${c.evidence}`),
      ].join('\n\n'));
      const questions: Record<string, { type: 'noul'; instructions: string }> = {};
      for (const c of batch) questions[c.id] = { type: 'noul', instructions: `Is the exact OUTPUT of CALL ${c.id} still needed to finish the current work described by TASK and LATEST, such that re-running the tool later would be worse than keeping this output now?` };
      const answers = await ctx.ask(state, questions);
      jevRequests++;
      for (const c of batch) scores.set(c.id, answers[c.id] ?? 0.5);
    }
    const ranked = [...candidates].sort((a, b) => (scores.get(a.id) ?? 0.5) - (scores.get(b.id) ?? 0.5));
    for (const c of ranked) {
      const p = scores.get(c.id) ?? 0.5;
      if (after <= targetChars) { decisions.push({ id: c.id, tool: c.tool, kind: c.kind, action: 'jev_kept', chars: c.result.text.length, p, head: `${c.tool} ${inputHead(c.input)}` }); continue; }
      dropped.push({ tool: c.tool, input: c.input, result: c.result.text });
      setResult(c.mi, c.ri, `[pruned ${c.result.text.length} chars of ${c.tool} output (p=${p.toFixed(2)}) — re-run if needed] ${c.result.text.slice(0, 120).replace(/\s+/g, ' ')}`);
      decisions.push({ id: c.id, tool: c.tool, kind: c.kind, action: 'jev_dropped', chars: c.result.text.length, p, head: `${c.tool} ${inputHead(c.input)}` });
      jevDropped++;
      after = sizeOf(messages);
    }
  } else {
    for (const c of candidates) decisions.push({ id: c.id, tool: c.tool, kind: c.kind, action: 'kept', chars: c.result.text.length, head: `${c.tool} ${inputHead(c.input)}` });
  }

  // 4. the note: what is gone, so the assistant re-runs instead of guessing
  const note = buildNote(decisions, ctx.now);
  const out = [...messages];
  if (note) out.splice(1, 0, { role: 'user', text: note, toolUses: [] });

  after = sizeOf(out);
  return {
    messages: out, decisions, dropped, note,
    stats: { charsBefore, charsAfter: after, targetChars, messagesBefore: input.length, messagesAfter: out.length, byKind,
             jevRequests, jevCandidates: candidates.length, jevDropped, noiseChars, underTarget: after <= targetChars },
  };
}

export function reductionRatio(r: Result): number {
  return r.stats.charsBefore === 0 ? 0 : 1 - r.stats.charsAfter / r.stats.charsBefore;
}

function buildNote(decisions: Decision[], now: Date): string {
  const pruned = decisions.filter((d) => d.action === 'result_pruned' || d.action === 'jev_dropped');
  if (pruned.length === 0 && !decisions.some((d) => d.inputTrimmed)) return '';
  const groups = new Map<string, string[]>();
  for (const d of pruned) {
    const key = d.tool === 'Bash' ? (d.kind === 'verify' ? 'test/build runs' : 'Bash commands') : d.tool;
    const list = groups.get(key) ?? [];
    list.push(d.head.replace(/^\S+\s*/, '').slice(0, 50));
    groups.set(key, list);
  }
  const parts = [...groups.entries()].map(([k, v]) => `${v.length} ${k}${v.length <= 4 ? ` (${v.join('; ')})` : ` (e.g. ${v.slice(0, 3).join('; ')})`}`);
  const trimmedInputs = decisions.filter((d) => d.inputTrimmed).length;
  if (trimmedInputs) parts.push(`${trimmedInputs} long tool inputs shortened (scripts, file contents — the files are on disk)`);
  const ts = now.toISOString().slice(0, 16).replace('T', ' ');
  return `[jev-compact ${ts}] Context was pruned to make room. The full outputs of these older tool calls were removed and replaced by one-line stubs: ${parts.join('; ')}. Everything else is verbatim: all user and assistant text, every Edit/Write target path (long file contents/scripts are shortened, the files are on disk), every failing or error output, and the last messages. If you need a pruned output, re-run the tool rather than recall it from memory. The complete history remains in the session transcript on disk.`.slice(0, 1200);
}
