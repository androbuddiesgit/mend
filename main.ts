// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- section 5: three-tier matching, and a file's lines (section 3) ---

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrail(s);
  return stripBoth(s);
}
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const ok = o.map((s) => tierKey(s, tier));
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== ok[j]) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}
/** The first tier (0, then 1, then 2; strict: 0 only) where O occurs, and its positions. */
function matchTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/** Like matchTier, but only occurrences at or after `from`. */
function matchTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/** The first line at or after `from` equal to the anchor at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (tierKey(lines[i]!, t) === tierKey(anchor, t)) return i;
    }
  }
  return -1;
}

/** A file's lines: its break (CRLF when the first LF follows a CR, else LF) and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}
function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const lines = text.split(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}
function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/**
 * Build the replacement lines for an edit whose old lines are O and new lines are N.
 * Each part of N is either a context line (its index into O: written as the file's own
 * matched line, never the patch's) or a new line. At tier 2 the new lines are re-indented:
 * P is the leading whitespace of O's first line, F that of the file's first matched line.
 * `matched` is the file's lines at the match position.
 */
function buildNew(matched: string[], o: string[], n: { text: string; ctx: number | null }[], tier: number): string[] {
  const f = matched.length > 0 ? leadingWs(matched[0]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  return n.map((part) => {
    if (part.ctx !== null) return matched[part.ctx]!;
    if (tier === 2 && part.text !== '' && part.text.trim() !== '' && part.text.startsWith(p)) return f + part.text.slice(p.length);
    return part.text;
  });
}

/** Successful move edits, in order, so the output can say `R <old> -> <new>` for them. */
const moves: [string, string][] = [];
function recordMove(oldP: string, newP: string): void {
  moves.push([oldP, newP]);
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- section 6: unified diffs ---

type BodyKind = ' ' | '-' | '+' | '\\';
interface BodyLine {
  kind: BodyKind;
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

/** A `--- <path>` / `+++ <path>` header line: the text after the first four characters, up to the first tab, spaces removed; /dev/null is no file; a leading a/ or b/ is removed. */
function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab < 0 ? rest : rest.slice(0, tab)).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The old lines O (context + `-`) and the new lines N (context + `+`, with each context line's index into O) of a hunk or chunk body. */
function bodyParts(body: BodyLine[]): { o: string[]; n: { text: string; ctx: number | null }[] } {
  const o: string[] = [];
  const n: { text: string; ctx: number | null }[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push({ text: b.text, ctx: null });
  }
  return { o, n };
}

/** Apply one unified hunk to a file's lines; returns len(N) - len(O) for the running delta d. */
function applyHunk(f: FileLines, h: Hunk, d: number, strict: boolean, path: string): number {
  const { o, n } = bodyParts(h.body);
  // A `\` line after the hunk's last context or `+` line means the result has no final break.
  let lastCtxPlus = -1;
  for (let j = 0; j < h.body.length; j++) {
    const b = h.body[j]!;
    if (b.kind === ' ' || b.kind === '+') lastCtxPlus = j;
  }
  const noEol = lastCtxPlus >= 0 && h.body[lastCtxPlus + 1]?.kind === '\\';
  if (o.length === 0) {
    const at = Math.min(h.a + d, f.lines.length);
    const touchesEnd = at >= f.lines.length;
    const inserted = n.map((part) => part.text);
    f.lines.splice(at, 0, ...inserted);
    if (touchesEnd) f.finalBreak = !noEol;
    return n.length;
  }
  const m = matchTier(f.lines, o, strict);
  if (m === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = m.pos[0]!;
  for (const p of m.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const touchesEnd = best + o.length >= f.lines.length;
  const matched = f.lines.slice(best, best + o.length);
  const repl = buildNew(matched, o, n, m.tier);
  f.lines.splice(best, o.length, ...repl);
  if (touchesEnd) f.finalBreak = !noEol;
  return n.length - o.length;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let sec: UnifiedSection | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const closeBody = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      sec.hunks.push(hunk);
      hunk = null;
    }
  };
  const newSection = (oldP: string | null, newP: string | null): void => {
    closeBody();
    sec = { oldPath: oldP, newPath: newP, create: false, remove: false, hasPair: false, hunks: [] };
    sections.push(sec);
    inHeader = true;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (hunk !== null) {
      if (l.startsWith('diff --git ')) closeBody();
      else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) closeBody();
      else if (l.startsWith('@@')) closeBody();
      else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        hunk.body.push({ kind: l === '' ? ' ' : (l[0] as BodyKind), text: l === '' ? '' : l.slice(1) });
        continue;
      } else closeBody();
    }
    if (l === 'diff --git' || l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inHeader && sec !== null && !sec.hasPair) {
        sec.oldPath = headerPath(l);
        sec.newPath = headerPath(lines[i + 1]!);
        sec.hasPair = true;
        i++;
        continue;
      }
      newSection(headerPath(l), headerPath(lines[i + 1]!));
      sec!.hasPair = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      hunk = { a: Number(m[1]), body: [] };
      continue;
    }
    if (inHeader && sec !== null) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        if (!sec.hasPair) sec.oldPath = l.slice('rename from '.length).trim();
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!sec.hasPair) sec.newPath = l.slice('rename to '.length).trim();
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.create = true;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.remove = true;
        continue;
      }
      continue;
    }
    // Prose outside bodies and headers is ignored.
  }
  closeBody();
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  const kind = sec.create || sec.oldPath === null ? 'create' : sec.remove || sec.newPath === null ? 'delete' : sec.oldPath !== sec.newPath ? 'move' : 'change';
  return (tree) => {
    const paths = kind === 'move' ? [sec.oldPath!, sec.newPath!] : kind === 'create' ? [sec.newPath!] : [sec.oldPath!];
    for (const p of paths) {
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
    }
    if (kind === 'create') {
      if (sec.newPath === null) return;
      if (tree.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          const b = h.body[j]!;
          if (b.kind === '+') {
            plus.push(b.text);
            noEol = h.body[j + 1]?.kind === '\\';
          }
        }
      }
      tree.now.set(sec.newPath, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      if (sec.oldPath === null) return;
      if (tree.get(sec.oldPath) === null) throw new Fail('missing', sec.oldPath);
      tree.now.set(sec.oldPath, null);
      return;
    }
    const before = tree.get(sec.oldPath!);
    if (before === null) throw new Fail('missing', sec.oldPath!);
    if (kind === 'move' && tree.get(sec.newPath!) !== null) throw new Fail('exists', sec.newPath!);
    const f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(f, h, d, strict, sec.oldPath!);
    const text = joinFile(f);
    if (kind === 'move') {
      tree.now.set(sec.newPath!, text);
      tree.now.set(sec.oldPath!, null);
      recordMove(sec.oldPath!, sec.newPath!);
    } else {
      tree.now.set(sec.oldPath!, text);
    }
  };
}

// --- section 7: SEARCH/REPLACE blocks ---

interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (eq < 0 && l.trimEnd() === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && l.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SearchReplaceBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const m = matchTier(f.lines, b.oldLines, strict);
    if (m === null) throw new Fail('no-match', b.path);
    if (m.pos.length > 1) throw new Fail('ambiguous', b.path);
    const at = m.pos[0]!;
    const matched = f.lines.slice(at, at + b.oldLines.length);
    const repl = buildNew(matched, b.oldLines, b.newLines.map((t) => ({ text: t, ctx: null as number | null })), m.tier);
    f.lines.splice(at, b.oldLines.length, ...repl);
    tree.now.set(b.path, joinFile(f));
  };
}

// --- section 8: V4A patches ---

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const sec: V4aSection = { kind: 'add', path: l.slice('*** Add File: '.length).trim(), moveTo: null, lines: [], chunks: [] };
      i++;
      const raw: string[] = [];
      const rawStart = i;
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      for (let k = 0; k < raw.length; k++) {
        const c = raw[k]!;
        if (c === '') sec.lines.push('');
        else if (c.startsWith('+')) sec.lines.push(c.slice(1));
        else throw new Exit2(`error: parse ${rawStart + k + 1}`);
      }
      sections.push(sec);
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const sec: V4aSection = { kind: 'delete', path: l.slice('*** Delete File: '.length).trim(), moveTo: null, lines: [], chunks: [] };
      i++;
      while (i < last && !isSectionStart(lines[i]!)) {
        if (blank(lines[i]!)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push(sec);
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const updateLine = i;
      const sec: V4aSection = { kind: 'update', path: l.slice('*** Update File: '.length).trim(), moveTo: null, lines: [], chunks: [] };
      i++;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      let chunk: V4aChunk | null = null;
      let closedByEof = false;
      const closeChunk = (): void => {
        if (chunk !== null) {
          sec.chunks.push(chunk);
          chunk = null;
        }
      };
      while (i < last && !isSectionStart(lines[i]!)) {
        const c = lines[i]!;
        if (c.startsWith('@@')) {
          closeChunk();
          const anchor = c.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          closedByEof = false;
          i++;
          continue;
        }
        if (c.trim() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
          chunk.eof = true;
          closeChunk();
          closedByEof = true;
          i++;
          continue;
        }
        if (closedByEof) {
          if (blank(c)) {
            i++;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        if (c === '' || c.startsWith(' ') || c.startsWith('-') || c.startsWith('+')) {
          if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
          chunk.body.push({ kind: c === '' ? ' ' : (c[0] as BodyKind), text: c === '' ? '' : c.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      if (sec.chunks.length > 0) {
        const lastChunk = sec.chunks[sec.chunks.length - 1]!;
        while (lastChunk.body.length > 0) {
          const b = lastChunk.body[lastChunk.body.length - 1]!;
          if (b.kind === ' ' && b.text.trim() === '') lastChunk.body.pop();
          else break;
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const a = findAnchor(f.lines, chunk.anchor, cursor, strict);
        if (a < 0) throw new Fail('no-match', sec.path);
        cursor = a + 1;
      }
      const { o, n } = bodyParts(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        const inserted = n.map((part) => part.text);
        f.lines.splice(at, 0, ...inserted);
        cursor = at + inserted.length;
        continue;
      }
      const m = matchTierFrom(f.lines, o, cursor, strict);
      if (m === null) throw new Fail('no-match', sec.path);
      let at = m.pos[0]!;
      if (chunk.eof) {
        const ok = m.pos.filter((p) => p + o.length === f.lines.length);
        if (ok.length === 0) throw new Fail('no-match', sec.path);
        at = ok[0]!;
      }
      const matched = f.lines.slice(at, at + o.length);
      const repl = buildNew(matched, o, n, m.tier);
      f.lines.splice(at, o.length, ...repl);
      cursor = at + repl.length;
    }
    const text = joinFile(f);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, text);
      tree.now.set(sec.path, null);
      recordMove(sec.path, sec.moveTo);
    } else {
      tree.now.set(sec.path, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  moves.length = 0;
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const rows: { key: string; text: string }[] = changed.map((p) => {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    return { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
  });
  // A file a move edit moved, when <old> existed before the patch and does not after it and <new> did not
  // exist before it and does after it, is one `R <old> -> <new>` line (sorted by <new>) instead of its D and A lines.
  for (const [oldP, newP] of moves) {
    const dIdx = rows.findIndex((r) => r.text === `D ${oldP}`);
    const aIdx = rows.findIndex((r) => r.text === `A ${newP}`);
    if (dIdx >= 0 && aIdx >= 0) {
      rows.splice(Math.max(dIdx, aIdx), 1);
      rows.splice(Math.min(dIdx, aIdx), 1);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.text);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
