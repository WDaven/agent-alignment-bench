#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import { Parser } from 'yaml';

const SCRIPT_LANGUAGES = new Map([
  ['.ts', 'ts'],
  ['.mts', 'ts'],
  ['.cts', 'ts'],
  ['.tsx', 'tsx'],
  ['.js', 'js'],
  ['.mjs', 'js'],
  ['.cjs', 'js'],
  ['.jsx', 'jsx'],
]);

const JSON_EXTENSIONS = new Set(['.json', '.jsonc']);
const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);
const SHELL_EXTENSIONS = new Set(['.sh', '.bash', '.zsh']);
const HASH_LINE_BASENAMES = new Set([
  '.gitignore',
  '.prettierignore',
  '.dockerignore',
  '.npmignore',
  '.gitattributes',
  '.nvmrc',
  '.editorconfig',
]);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

const TS_EXPECT_ERROR = /^\s*@ts-expect-error(\s|$)/;
const TRIPLE_SLASH_REFERENCE = /^\/\s*<reference\s/;
const DOCKER_DIRECTIVE = /^#\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*\S/;
const ALLOWED_DOCKER_DIRECTIVES = new Set(['syntax']);

export function classifyFile(filePath, text) {
  const base = path.basename(filePath);
  const ext = path.extname(base).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) return null;
  if (SCRIPT_LANGUAGES.has(ext)) return 'script';
  if (JSON_EXTENSIONS.has(ext)) return 'json';
  if (YAML_EXTENSIONS.has(ext)) return 'yaml';
  if (SHELL_EXTENSIONS.has(ext)) return 'shell';
  if (HASH_LINE_BASENAMES.has(base) || ext === '.dockerignore') return 'hash-lines';
  if (base === 'Dockerfile' || ext === '.dockerfile' || base.startsWith('Dockerfile.')) {
    return 'dockerfile';
  }
  if (ext === '' && typeof text === 'string' && text.startsWith('#!')) {
    const interpreter = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
    if (/\b(node|deno|bun|tsx)\b/.test(interpreter)) return 'script';
    if (/\b(sh|bash|zsh|dash|ksh)\b/.test(interpreter)) return 'shell';
  }
  return null;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function finding(starts, text, start, end) {
  const raw = text.slice(start, end).split('\n')[0].trim();
  return { line: lineOf(starts, start), text: raw.length > 80 ? `${raw.slice(0, 77)}...` : raw };
}

function scriptLanguage(filePath) {
  return SCRIPT_LANGUAGES.get(path.extname(filePath).toLowerCase()) ?? 'js';
}

export function findScriptComments(filePath, text) {
  const result = parseSync(filePath, text, { lang: scriptLanguage(filePath) });
  const errors = result.errors.filter((e) => e.severity === undefined || e.severity === 'Error');
  if (errors.length > 0) {
    throw new Error(`${filePath}: cannot parse (${errors[0].message})`);
  }
  const starts = lineStarts(text);
  const found = [];
  for (const comment of result.comments) {
    if (comment.start === 0 && text.startsWith('#!')) continue;
    if (comment.type === 'Line' && TS_EXPECT_ERROR.test(comment.value)) continue;
    if (comment.type === 'Line' && TRIPLE_SLASH_REFERENCE.test(comment.value)) continue;
    found.push(finding(starts, text, comment.start, comment.end));
  }
  return found;
}

export function findJsonComments(text) {
  const starts = lineStarts(text);
  const found = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      found.push(finding(starts, text, i, stop));
      i = stop;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      found.push(finding(starts, text, i, stop));
      i = stop - 1;
    }
  }
  return found;
}

function collectYamlComments(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectYamlComments(item, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (node.type === 'comment' && typeof node.offset === 'number') {
    out.push(node);
    return;
  }
  for (const value of Object.values(node)) collectYamlComments(value, out);
}

export function findYamlComments(text) {
  const starts = lineStarts(text);
  const tokens = [];
  for (const token of new Parser().parse(text)) collectYamlComments(token, tokens);
  return tokens
    .sort((a, b) => a.offset - b.offset)
    .map((t) => finding(starts, text, t.offset, t.offset + t.source.length));
}

export function findHashLineComments(text, { semicolon = false } = {}) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#') || (semicolon && trimmed.startsWith(';'))) {
      found.push({ line: index + 1, text: trimmed.trim() });
    }
  });
  return found;
}

const SHELL_WORD_BREAK = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>', '`']);

function readHeredocDelimiter(text, i) {
  let j = i + 2;
  let stripTabs = false;
  if (text[j] === '-') {
    stripTabs = true;
    j++;
  }
  while (text[j] === ' ' || text[j] === '\t') j++;
  let word = '';
  while (j < text.length && !SHELL_WORD_BREAK.has(text[j])) {
    const c = text[j];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, j + 1);
      if (close === -1) break;
      word += text.slice(j + 1, close);
      j = close + 1;
    } else if (c === '\\') {
      word += text[j + 1] ?? '';
      j += 2;
    } else {
      word += c;
      j++;
    }
  }
  return word ? { word, stripTabs, end: j } : null;
}

function skipHeredocBodies(text, newlineIndex, pending) {
  let pos = newlineIndex + 1;
  for (const { word, stripTabs } of pending) {
    while (pos < text.length) {
      const eol = text.indexOf('\n', pos);
      const stop = eol === -1 ? text.length : eol;
      let line = text.slice(pos, stop);
      if (stripTabs) line = line.replace(/^\t+/, '');
      pos = stop + 1;
      if (line === word) break;
    }
  }
  return pos - 1;
}

function skipBalancedBrace(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (c === "'" || c === '"') {
      const close = text.indexOf(c, j + 1);
      if (close === -1) return text.length - 1;
      j = close;
    } else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return text.length - 1;
}

function skipDoubleQuoted(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '"') return j;
  }
  return text.length - 1;
}

function skipAnsiCQuoted(text, i) {
  for (let j = i + 2; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === "'") return j;
  }
  return text.length - 1;
}

export function findShellComments(text) {
  const starts = lineStarts(text);
  const found = [];
  let pendingHeredocs = [];
  let i = 0;
  if (text.startsWith('#!')) {
    const eol = text.indexOf('\n');
    i = eol === -1 ? text.length : eol;
  }
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? text.length : close;
    } else if (c === '"') {
      i = skipDoubleQuoted(text, i);
    } else if (c === '$' && text[i + 1] === "'") {
      i = skipAnsiCQuoted(text, i);
    } else if (c === '$' && text[i + 1] === '{') {
      i = skipBalancedBrace(text, i + 1);
    } else if (c === '$' && text[i + 1] === '#') {
      i++;
    } else if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      const heredoc = readHeredocDelimiter(text, i);
      if (heredoc) {
        pendingHeredocs.push(heredoc);
        i = heredoc.end - 1;
      } else {
        i++;
      }
    } else if (c === '<' && text[i + 1] === '<' && text[i + 2] === '<') {
      i += 2;
    } else if (c === '\n') {
      if (pendingHeredocs.length > 0) {
        i = skipHeredocBodies(text, i, pendingHeredocs);
        pendingHeredocs = [];
      }
    } else if (c === '#' && (i === 0 || SHELL_WORD_BREAK.has(text[i - 1]))) {
      const eol = text.indexOf('\n', i);
      const stop = eol === -1 ? text.length : eol;
      found.push(finding(starts, text, i, stop));
      i = stop - 1;
    }
  }
  return found;
}

const DOCKER_HEREDOC = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
const DOCKER_SHELL_FORM_INSTRUCTION = /^(RUN|CMD|ENTRYPOINT)\s+(?!\[)/i;

function shellCommentsInInstruction(lines, first, last) {
  const body = [];
  for (let k = first; k <= last; k++) {
    const line = lines[k];
    if (k > first && line.trimStart().startsWith('#')) {
      body.push('');
      continue;
    }
    const text = k === first ? line.trimStart().replace(DOCKER_SHELL_FORM_INSTRUCTION, '') : line;
    body.push(text.replace(/\\\s*$/, ''));
  }
  return findShellComments(body.join('\n')).map((c) => ({ line: first + c.line, text: c.text }));
}

export function findDockerfileComments(text) {
  const lines = text.split('\n');
  const found = [];
  let index = 0;
  while (index < lines.length) {
    const match = DOCKER_DIRECTIVE.exec(lines[index].trim());
    if (!match) break;
    if (!ALLOWED_DOCKER_DIRECTIVES.has(match[1].toLowerCase())) {
      found.push({ line: index + 1, text: lines[index].trim() });
    }
    index++;
  }
  const pending = [];
  while (index < lines.length) {
    const line = lines[index];
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift();
      index++;
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) {
      found.push({ line: index + 1, text: trimmed.trim() });
      index++;
      continue;
    }
    let last = index;
    while (last < lines.length - 1 && /\\\s*$/.test(lines[last])) {
      last++;
      if (lines[last].trimStart().startsWith('#')) {
        found.push({ line: last + 1, text: lines[last].trim() });
      }
    }
    const heredocs = [...trimmed.matchAll(DOCKER_HEREDOC)].map((m) => m[2]);
    if (heredocs.length === 0 && DOCKER_SHELL_FORM_INSTRUCTION.test(trimmed)) {
      found.push(...shellCommentsInInstruction(lines, index, last));
    }
    pending.push(...heredocs);
    index = last + 1;
  }
  return found.sort((a, b) => a.line - b.line);
}

export function findComments(filePath, text) {
  switch (classifyFile(filePath, text)) {
    case 'script':
      return findScriptComments(filePath, text);
    case 'json':
      return findJsonComments(text);
    case 'yaml':
      return findYamlComments(text);
    case 'shell':
      return findShellComments(text);
    case 'dockerfile':
      return findDockerfileComments(text);
    case 'hash-lines':
      return findHashLineComments(text, {
        semicolon: path.basename(filePath) === '.editorconfig',
      });
    default:
      return [];
  }
}

export function trackedFiles(cwd) {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd, encoding: 'utf8' },
  );
  return out.split('\0').filter((f) => f.length > 0);
}

export function checkFiles(cwd, files) {
  const problems = [];
  for (const file of files) {
    const absolute = path.resolve(cwd, file);
    if (!existsSync(absolute)) continue;
    const text = readFileSync(absolute, 'utf8');
    try {
      for (const c of findComments(file, text)) problems.push(`${file}:${c.line}: ${c.text}`);
    } catch (error) {
      problems.push(`${file}:0: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

function main() {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args : trackedFiles(cwd);
  const problems = checkFiles(cwd, files);
  if (problems.length === 0) {
    process.stdout.write(`check-no-comments: ${files.length} files, no comments\n`);
    return;
  }
  process.stderr.write(`${problems.join('\n')}\n`);
  process.stderr.write(
    `check-no-comments: ${problems.length} comment(s) found; see AGENTS.md for where knowledge goes instead\n`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
