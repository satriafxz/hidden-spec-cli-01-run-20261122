// mend: one patch tool for every AI edit format (sections 1-10 of SPEC.md).
// Sections 1-4, 9 and 10 follow the kit starter; sections 5-8 are written here.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.

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

// ---------------------------------------------------------------- section 5: matching lines

type Match = { tier: number; positions: number[] };

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Occurrences of O in F at or after `start`; overlapping is allowed. */
function findTier(O: string[], F: string[], strict: boolean, start: number, endOnly: boolean): Match | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = start; i + O.length <= F.length; i += 1) {
      if (endOnly && i + O.length !== F.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (normLine(O[j]!, tier) !== normLine(F[i + j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** N written over F at pos. Context lines are the file's own lines. */
function render(O: string[], N: string[], Octx: boolean[], Nctx: boolean[], F: string[], pos: number, tier: number): string[] {
  const contextAt: number[] = [];
  for (let k = 0; k < O.length; k += 1) if (Octx[k]) contextAt.push(k);
  let ci = 0;
  let prefix = '';
  let pat = '';
  if (tier === 2) {
    prefix = /^[ \t]*/.exec(F[0] ?? '')![0];
    pat = /^[ \t]*/.exec(O[0] ?? '')![0];
  }
  return N.map((line, j) => {
    if (Nctx[j]) {
      const at = contextAt[ci] ?? ci;
      ci += 1;
      return F[at] ?? line;
    }
    if (tier === 2 && line.trim() !== '' && line.startsWith(pat)) return prefix + line.slice(pat.length);
    return line;
  });
}

// ---------------------------------------------------------------- file line breaks

type Parts = { lines: string[]; br: string; final: boolean };

function fileParts(text: string): Parts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinParts(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------- section 6: unified diffs

type UKind = ' ' | '-' | '+';
type UEntry = { kind: UKind; text: string; noEol: boolean };
type UHunk = { A: number; body: UEntry[] };
type USection = {
  old: string | null;
  new: string | null;
  diffOld: string | null;
  diffNew: string | null;
  hasPaths: boolean;
  forced: 'change' | 'create' | 'delete';
  hunks: UHunk[];
};

const movePairs: { old: string; newPath: string }[] = [];

function stripPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function emptySection(): USection {
  return { old: null, new: null, diffOld: null, diffNew: null, hasPaths: false, forced: 'change', hunks: [] };
}

function splitBody(body: UEntry[]): { O: string[]; N: string[]; Oc: boolean[]; Nc: boolean[]; lastNoEol: boolean } {
  const O: string[] = [];
  const N: string[] = [];
  const Oc: boolean[] = [];
  const Nc: boolean[] = [];
  for (const e of body) {
    if (e.kind === ' ' || e.kind === '-') {
      O.push(e.text);
      Oc.push(e.kind === ' ');
    }
    if (e.kind === ' ' || e.kind === '+') {
      N.push(e.text);
      Nc.push(e.kind === ' ');
    }
  }
  let lastNoEol = false;
  for (let j = body.length - 1; j >= 0; j -= 1) {
    const e = body[j]!;
    if (e.kind === ' ' || e.kind === '+') {
      lastNoEol = e.noEol;
      break;
    }
  }
  return { O, N, Oc, Nc, lastNoEol };
}

function applyHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  const parts = fileParts(text);
  const cur = parts.lines.slice();
  let finalBreak = parts.final;
  let d = 0;
  for (const h of hunks) {
    const { O, N, Oc, Nc, lastNoEol } = splitBody(h.body);
    let atEnd = false;
    if (O.length > 0) {
      const m = findTier(O, cur, strict, 0, false);
      if (m === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let pos = m.positions[0]!;
      for (const p of m.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const wrote = render(O, N, Oc, Nc, cur.slice(pos, pos + O.length), pos, m.tier);
      atEnd = pos + O.length === cur.length;
      cur.splice(pos, O.length, ...wrote);
    } else {
      const pos = Math.min(h.A + d, cur.length);
      atEnd = pos === cur.length;
      cur.splice(pos, 0, ...N);
    }
    if (atEnd) finalBreak = cur.length > 0 && !lastNoEol;
    d += N.length - O.length;
  }
  return joinParts(cur, parts.br, finalBreak);
}

function createdFile(hunks: UHunk[]): string {
  const plus: UEntry[] = [];
  for (const h of hunks) for (const e of h.body) if (e.kind === '+') plus.push(e);
  if (plus.length === 0) return '';
  const last = plus[plus.length - 1]!;
  return plus.map((e) => e.text).join('\n') + (last.noEol ? '' : '\n');
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  movePairs.length = 0;
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.startsWith('diff --git ')) {
      const m = /^diff --git (\S+) (\S+)\s*$/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = emptySection();
      cur.diffOld = stripPath(m[1]!);
      cur.diffNew = stripPath(m[2]!);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (L.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.hasPaths) {
        cur = emptySection();
        sections.push(cur);
      }
      cur.old = stripPath(L.slice(4));
      cur.new = stripPath(lines[i + 1]!.slice(4));
      cur.hasPaths = true;
      i += 2;
      continue;
    }
    if (L.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (L.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { A: Number(m[1]!), body: [] };
      i += 1;
      while (i < lines.length) {
        const B = lines[i]!;
        if (B.startsWith('diff --git ') || (B.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
        if (B === '' || B.startsWith(' ') || B.startsWith('-') || B.startsWith('+') || B.startsWith('\\')) {
          if (B.startsWith('\\')) {
            const last = hunk.body[hunk.body.length - 1];
            if (last !== undefined) last.noEol = true;
          } else {
            const kind: UKind = B === '' ? ' ' : (B[0] as UKind);
            hunk.body.push({ kind, text: B === '' ? '' : B.slice(1), noEol: false });
          }
          i += 1;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && !cur.hasPaths && L.startsWith('rename from ')) {
      cur.old = stripPath(L.slice(12));
    } else if (cur !== null && !cur.hasPaths && L.startsWith('rename to ')) {
      cur.new = stripPath(L.slice(10));
    } else if (cur !== null && L.startsWith('new file mode')) {
      cur.forced = 'create';
    } else if (cur !== null && L.startsWith('deleted file mode')) {
      cur.forced = 'delete';
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s) => {
    const oldP = s.old === undefined || s.old === null ? (s.forced === 'create' ? null : s.diffOld) : s.old;
    const newP = s.new === undefined || s.new === null ? (s.forced === 'delete' ? null : s.diffNew) : s.new;
    const mode: 'create' | 'delete' | 'move' | 'change' =
      s.forced === 'create' || oldP === null ? 'create' :
      s.forced === 'delete' || newP === null ? 'delete' :
      oldP !== newP ? 'move' : 'change';
    return (tree: Tree): void => {
      if (mode !== 'create' && oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (mode !== 'delete' && newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (mode === 'create') {
        if (newP === null || !safe(newP)) throw new Fail('unsafe', newP ?? '');
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        tree.now.set(newP, createdFile(s.hunks));
        return;
      }
      if (oldP === null || !safe(oldP)) throw new Fail('unsafe', oldP ?? '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (mode === 'delete') {
        tree.now.set(oldP, null);
        return;
      }
      if (newP === null || !safe(newP)) throw new Fail('unsafe', newP ?? '');
      const result = applyHunks(tree.get(oldP)!, s.hunks, strict, oldP);
      if (mode === 'move') {
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        tree.now.set(oldP, null);
        tree.now.set(newP, result);
        movePairs.push({ old: oldP, newPath: newP });
      } else {
        tree.now.set(oldP, result);
      }
    };
  });
}

// ---------------------------------------------------------------- section 7: SEARCH/REPLACE blocks

type Block = { path: string | null; lineNo: number; old: string[]; next: string[] };

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: Block[] = [];
  let lastReplace = 0;
  let previousPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======' && lines[j]!.trimEnd() !== '<<<<<<< SEARCH') j += 1;
    let k = j + 1;
    if (j < lines.length && lines[j]!.trimEnd() === '=======') {
      while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE' && lines[k]!.trimEnd() !== '<<<<<<< SEARCH') k += 1;
    }
    if (j >= lines.length || lines[j]!.trimEnd() !== '=======' || k >= lines.length || lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    let path: string | null = null;
    for (let r = i - 1; r >= lastReplace; r -= 1) {
      const t = lines[r]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = previousPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, lineNo: i + 1, old: lines.slice(i + 1, j), next: lines.slice(j + 1, k) });
    previousPath = path;
    lastReplace = k + 1;
    i = k;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const p = b.path!;
    const old = b.old;
    const next = b.next;
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, next.length === 0 ? '' : next.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = fileParts(before);
      const m = findTier(old, parts.lines, strict, 0, false);
      if (m === null) throw new Fail('no-match', p);
      if (m.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = m.positions[0]!;
      const wrote = render(old, next, old.map(() => false), next.map(() => false), parts.lines.slice(pos, pos + old.length), pos, m.tier);
      const out = parts.lines.slice();
      out.splice(pos, old.length, ...wrote);
      tree.now.set(p, joinParts(out, parts.br, parts.final));
    };
  });
}

// ---------------------------------------------------------------- section 8: V4A patches

type PL = { t: string; n: number };
type VChunk = { anchor: string | null; body: UEntry[]; eof: boolean };
type VSection = { kind: 'add' | 'delete' | 'update'; path: string; header: PL; raw: PL[] };

function parseV8Body(raw: PL[]): { anchor: string | null; body: UEntry[]; eof: boolean }[] {
  const chunks: VChunk[] = [];
  let chunk: VChunk | null = null;
  let closed = false;
  for (const x of raw) {
    if (x.t === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${x.n}`);
      chunk.eof = true;
      chunks.push(chunk);
      chunk = null;
      closed = true;
      continue;
    }
    if (x.t.startsWith('@@')) {
      if (chunk !== null) chunks.push(chunk);
      chunk = { anchor: x.t.slice(2).trim() || null, body: [], eof: false };
      closed = false;
      continue;
    }
    if (x.t === '' || x.t.startsWith(' ') || x.t.startsWith('-') || x.t.startsWith('+')) {
      if (chunk === null) {
        if (closed || chunks.length > 0) throw new Exit2(`error: parse ${x.n}`);
        chunk = { anchor: null, body: [], eof: false };
      }
      if (blank(x.t)) chunk.body.push({ kind: ' ', text: '', noEol: false });
      else chunk.body.push({ kind: x.t[0] as UKind, text: x.t.slice(1), noEol: false });
      continue;
    }
    throw new Exit2(`error: parse ${x.n}`);
  }
  if (chunk !== null) chunks.push(chunk);
  return chunks;
}

function applyChunks(text: string, chunks: { anchor: string | null; body: UEntry[]; eof: boolean }[], strict: boolean, path: string): string {
  const parts = fileParts(text);
  const cur = parts.lines.slice();
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const m = findTier([ch.anchor], cur, strict, cursor, false);
      if (m === null) throw new Fail('no-match', path);
      cursor = m.positions[0]! + 1;
    }
    const { O, N, Oc, Nc } = splitBody(ch.body);
    if (O.length > 0) {
      const m = findTier(O, cur, strict, cursor, ch.eof);
      if (m === null) throw new Fail('no-match', path);
      const pos = m.positions[0]!;
      const wrote = render(O, N, Oc, Nc, cur.slice(pos, pos + O.length), pos, m.tier);
      cur.splice(pos, O.length, ...wrote);
      cursor = pos + wrote.length;
    } else {
      const pos = ch.eof ? cur.length : Math.min(cursor, cur.length);
      cur.splice(pos, 0, ...N);
      cursor = pos + N.length;
    }
  }
  return joinParts(cur, parts.br, parts.final);
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  movePairs.length = 0;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const all: PL[] = [];
  for (let i = first + 1; i < last; i += 1) all.push({ t: lines[i]!, n: i + 1 });
  const sections: VSection[] = [];
  let i = 0;
  while (i < all.length) {
    if (blank(all[i]!.t)) {
      i += 1;
      continue;
    }
    const m = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(all[i]!.t);
    if (m === null) throw new Exit2(`error: parse ${all[i]!.n}`);
    const header = all[i]!;
    const kind = m[1] === 'Add' ? 'add' : m[1] === 'Delete' ? 'delete' : 'update';
    i += 1;
    const raw: PL[] = [];
    while (i < all.length) {
      const t = all[i]!.t;
      if (/^\*\*\* (Add|Delete|Update) File: /.test(t)) break;
      raw.push(all[i]!);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
    sections.push({ kind, path: m[2]!.trim(), header, raw });
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s) => {
    let newPath: string | null = null;
    let chunks: { anchor: string | null; body: UEntry[]; eof: boolean }[] = [];
    if (s.kind === 'add') {
      for (const x of s.raw) {
        if (x.t.startsWith('+')) continue;
        if (blank(x.t)) continue;
        throw new Exit2(`error: parse ${x.n}`);
      }
    } else if (s.kind === 'delete') {
      if (s.raw.length > 0) throw new Exit2(`error: parse ${s.raw[0]!.n}`);
    } else {
      let start = 0;
      if (s.raw[0]?.t.startsWith('*** Move to: ')) {
        newPath = s.raw[0].t.slice(13).trim();
        start = 1;
      }
      chunks = parseV8Body(s.raw.slice(start));
      if (chunks.length === 0 && newPath === null) throw new Exit2(`error: parse ${s.header.n}`);
    }
    return (tree: Tree): void => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (s.kind === 'add') {
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        const body = s.raw.map((x) => (x.t.startsWith('+') ? x.t.slice(1) : ''));
        tree.now.set(s.path, body.length === 0 ? '' : body.join('\n') + '\n');
        return;
      }
      const before = tree.get(s.path);
      if (before === null) throw new Fail('missing', s.path);
      if (s.kind === 'delete') {
        tree.now.set(s.path, null);
        return;
      }
      if (newPath !== null && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const result = applyChunks(before, chunks, strict, s.path);
      if (newPath !== null) {
        tree.now.set(s.path, null);
        tree.now.set(newPath, result);
        movePairs.push({ old: s.path, newPath });
      } else {
        tree.now.set(s.path, result);
      }
    };
  });
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
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines) :
      kind === 'unified' ? unifiedEdits(lines, strict) :
      kind === 'search-replace' ? searchReplaceEdits(lines, strict) :
      kind === 'v4a' ? v4aEdits(lines, strict) : [];
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
  const rows: { key: string; line: string; path: string | null }[] = [];
  const moved: { old: string; newPath: string }[] = [];
  const hidden = new Set<string>();
  for (const mv of movePairs) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.newPath) === null && tree.get(mv.newPath) !== null) {
      moved.push(mv);
      hidden.add(mv.old);
      hidden.add(mv.newPath);
      rows.push({ key: mv.newPath, line: `R ${mv.old} -> ${mv.newPath}`, path: null });
    }
  }
  for (const p of tree.now.keys()) {
    if (hidden.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const row of rows) {
      if (row.path === null) continue;
      const now = tree.now.get(row.path)!;
      if (now === null) rmSync(row.path, { force: true });
      else {
        mkdirSync(dirname(row.path), { recursive: true });
        writeFileSync(row.path, now);
      }
    }
    for (const mv of moved) {
      rmSync(mv.old, { force: true });
      const now = tree.now.get(mv.newPath)!;
      mkdirSync(dirname(mv.newPath), { recursive: true });
      writeFileSync(mv.newPath, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
