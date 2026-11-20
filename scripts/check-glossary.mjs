#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

export const GLOSSARY_FILE = 'AGENTS.md';
export const GLOSSARY_COLUMNS = ['Term', 'Meaning', 'Used in names as', 'Avoid'];
export const ROOT_PREAMBLE_MAX_LINES = 30;

const SCRIPT_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']);
const CORPUS_EXTENSIONS = new Set([...SCRIPT_EXTENSIONS, '.json', '.yaml', '.yml', '.sh']);
const TERM_PATTERN = /^`([A-Za-z][A-Za-z0-9]*)`$/;
const BACKTICKED = /`([^`]+)`/g;
const FOLDER_SEGMENT = /^\.?[a-z0-9]+(-[a-z0-9]+)*$/;

export function splitWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

function containsWordRun(words, run) {
  if (run.length === 0 || run.length > words.length) return false;
  for (let i = 0; i + run.length <= words.length; i++) {
    if (run.every((w, k) => words[i + k] === w)) return true;
  }
  return false;
}

function splitRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && inner[i + 1] === '|') {
      current += '|';
      i++;
    } else if (c === '`') {
      inCode = !inCode;
      current += c;
    } else if (c === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  cells.push(current.trim());
  return cells;
}

const isTableLine = (line) => line.trim().startsWith('|');
const isSeparator = (line) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line.trim());

export function backticked(cell) {
  return [...cell.matchAll(BACKTICKED)].map((m) => m[1].trim());
}

export function parseGlossary(file, text, { isRoot }) {
  const problems = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const tableStart = lines.findIndex(isTableLine);
  if (tableStart === -1) {
    return { terms: [], problems: [`${file}: no glossary table`] };
  }
  let tableEnd = tableStart;
  while (tableEnd < lines.length && isTableLine(lines[tableEnd])) tableEnd++;
  const before = lines.slice(0, tableStart);
  const after = lines.slice(tableEnd);
  if (after.some((l) => l.trim() !== '')) {
    problems.push(`${file}:${tableEnd + 1}: nothing may follow the glossary table`);
  }
  const nonEmptyBefore = before.filter((l) => l.trim() !== '');
  if (isRoot) {
    if (!/^# \S/.test(before[0] ?? '')) problems.push(`${file}:1: must start with an H1 title`);
    if (nonEmptyBefore.length > ROOT_PREAMBLE_MAX_LINES) {
      problems.push(
        `${file}: preamble has ${nonEmptyBefore.length} non-empty lines (max ${ROOT_PREAMBLE_MAX_LINES})`,
      );
    }
  } else if (nonEmptyBefore.length !== 1 || !/^# \S/.test(nonEmptyBefore[0])) {
    problems.push(`${file}: a nested glossary is an H1 title line and the table, nothing else`);
  }

  const header = splitRow(lines[tableStart]);
  if (header.join('|') !== GLOSSARY_COLUMNS.join('|')) {
    problems.push(
      `${file}:${tableStart + 1}: columns must be exactly ${GLOSSARY_COLUMNS.join(' | ')}`,
    );
  }
  if (!isSeparator(lines[tableStart + 1] ?? '')) {
    problems.push(`${file}:${tableStart + 2}: missing table separator row`);
  }

  const terms = [];
  for (let i = tableStart + 2; i < tableEnd; i++) {
    const cells = splitRow(lines[i]);
    const at = `${file}:${i + 1}`;
    if (cells.length !== GLOSSARY_COLUMNS.length) {
      problems.push(`${at}: expected ${GLOSSARY_COLUMNS.length} cells, found ${cells.length}`);
      continue;
    }
    const [termCell, meaning, usedIn, avoid] = cells;
    const term = TERM_PATTERN.exec(termCell)?.[1];
    if (!term) {
      problems.push(`${at}: Term must be one backticked identifier, got "${termCell}"`);
      continue;
    }
    if (meaning.length === 0) problems.push(`${at}: Meaning is empty for ${term}`);
    const examples = backticked(usedIn);
    if (examples.length === 0) problems.push(`${at}: Used in names as has no backticked example`);
    const avoidWords = avoid
      .split(',')
      .map((w) => w.replace(/`/g, '').trim())
      .filter((w) => w.length > 0);
    terms.push({ term, examples, avoid: avoidWords, file, line: i + 1 });
  }

  for (let k = 1; k < terms.length; k++) {
    const prev = terms[k - 1].term.toLowerCase();
    const curr = terms[k].term.toLowerCase();
    if (prev.localeCompare(curr, 'en') >= 0) {
      problems.push(`${file}:${terms[k].line}: ${terms[k].term} is not in alphabetical order`);
    }
  }
  return { terms, problems };
}

function collectIdentifiers(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectIdentifiers(item, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (
    (node.type === 'Identifier' || node.type === 'PrivateIdentifier') &&
    typeof node.name === 'string'
  ) {
    out.add(node.name);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'start' && key !== 'end') collectIdentifiers(value, out);
  }
}

export function scriptIdentifiers(file, text) {
  const ext = path.extname(file);
  const lang = ext === '.tsx' ? 'tsx' : ext.endsWith('ts') ? 'ts' : 'js';
  const result = parseSync(file, text, { lang });
  const out = new Set();
  collectIdentifiers(result.program, out);
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function exampleResolves(example, { paths, corpus }) {
  const name = example.replace(/\(\)$/, '').replace(/\/$/, '');
  if (paths.has(name)) return true;
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`);
  return pattern.test(corpus);
}

export function directoriesOf(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}

export function checkGlossaries({ files, read }) {
  const problems = [];
  const glossaryFiles = files.filter((f) => path.basename(f) === GLOSSARY_FILE).sort();
  if (!glossaryFiles.includes(GLOSSARY_FILE)) problems.push(`${GLOSSARY_FILE}: missing at root`);

  const dirs = directoriesOf(files);
  for (const dir of dirs) {
    const segment = path.basename(dir);
    if (!FOLDER_SEGMENT.test(segment)) problems.push(`${dir}/: folder names must be kebab-case`);
  }

  const paths = new Set([...files, ...dirs]);
  const sourceFiles = files.filter(
    (f) => CORPUS_EXTENSIONS.has(path.extname(f)) || path.basename(f).endsWith('Dockerfile'),
  );
  const corpus = sourceFiles.map((f) => read(f) ?? '').join('\n');
  const identifiers = new Set();
  for (const f of sourceFiles) {
    if (!SCRIPT_EXTENSIONS.has(path.extname(f))) continue;
    const text = read(f);
    if (text === null) continue;
    try {
      for (const id of scriptIdentifiers(f, text)) identifiers.add(id);
    } catch (error) {
      problems.push(`${f}: cannot parse (${error instanceof Error ? error.message : error})`);
    }
  }

  const definedIn = new Map();
  const allTerms = [];
  for (const file of glossaryFiles) {
    const text = read(file);
    if (text === null) continue;
    const parsed = parseGlossary(file, text, { isRoot: file === GLOSSARY_FILE });
    problems.push(...parsed.problems);
    for (const t of parsed.terms) {
      const key = t.term.toLowerCase();
      const first = definedIn.get(key);
      if (first) problems.push(`${t.file}:${t.line}: ${t.term} is already defined in ${first}`);
      else definedIn.set(key, `${t.file}:${t.line}`);
      allTerms.push(t);
    }
  }

  const named = [
    ...[...paths].map((p) => ({
      where: `path ${p}`,
      words: splitWords(path.basename(p).replace(/\.[^.]+$/, '')),
    })),
    ...[...identifiers].map((id) => ({ where: `identifier ${id}`, words: splitWords(id) })),
  ];
  for (const t of allTerms) {
    for (const example of t.examples) {
      if (!exampleResolves(example, { paths, corpus })) {
        problems.push(
          `${t.file}:${t.line}: example \`${example}\` for ${t.term} not found in the repo`,
        );
      }
    }
    for (const word of t.avoid) {
      const avoided = splitWords(word);
      for (const n of named) {
        if (containsWordRun(n.words, avoided)) {
          problems.push(
            `${t.file}:${t.line}: avoided word "${word}" (for ${t.term}) used in ${n.where}`,
          );
        }
      }
    }
  }
  return problems;
}

export function repoFiles(cwd) {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd,
      encoding: 'utf8',
    },
  );
  return out.split('\0').filter((f) => f.length > 0 && existsSync(path.join(cwd, f)));
}

function main() {
  const cwd = process.cwd();
  const files = repoFiles(cwd);
  const read = (f) => {
    try {
      return readFileSync(path.join(cwd, f), 'utf8');
    } catch {
      return null;
    }
  };
  const problems = checkGlossaries({ files, read });
  if (problems.length === 0) {
    const count = files.filter((f) => path.basename(f) === GLOSSARY_FILE).length;
    process.stdout.write(`check-glossary: ${count} glossaries, ${files.length} paths, ok\n`);
    return;
  }
  process.stderr.write(`${problems.join('\n')}\n`);
  process.stderr.write(`check-glossary: ${problems.length} problem(s)\n`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
