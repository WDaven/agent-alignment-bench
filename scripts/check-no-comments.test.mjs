import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  classifyFile,
  findComments,
  findDockerfileComments,
  findJsonComments,
  findShellComments,
  findYamlComments,
} from './check-no-comments.mjs';

const DOLLAR = '$';
const lines = (found) => found.map((c) => c.line);
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-no-comments.mjs');

describe('TypeScript and JavaScript', () => {
  it('does not mistake comment-like text in strings, templates and regex literals', () => {
    const source = [
      "const url = 'https://example.com/a//b';",
      'const block = "/* not a comment */";',
      `const tpl = \`// still text ${DOLLAR}{"/*"} and ${DOLLAR}{url}\`;`,
      'const re = /\\/\\/+/g;',
      'const cls = /[/*]/;',
      'const ratio = 10 / 2 / 5;',
      'type Nested = Array<Map<string, Set<number>>>;',
      `type Tpl<T extends string> = T extends \`//${DOLLAR}{string}\` ? true : false;`,
      'const id = <T,>(x: T): T => x;',
      'export { block, cls, id, ratio, re, tpl };',
      'export type { Nested, Tpl };',
    ].join('\n');
    expect(findComments('a.ts', source)).toEqual([]);
  });

  it('reports line, block, doc and trailing comments with their lines', () => {
    const source = [
      '// line',
      'const a = 1; // trailing',
      '/* block */',
      '/**',
      ' * doc',
      ' */',
      'export const b = a /* inline */ + 1;',
    ].join('\n');
    expect(lines(findComments('a.ts', source))).toEqual([1, 2, 3, 4, 7]);
  });

  it('allows only a line-1 shebang, @ts-expect-error and triple-slash references', () => {
    const allowed = [
      '#!/usr/bin/env node',
      '/// <reference types="node" />',
      '// @ts-expect-error intentionally wrong',
      'const n: number = "x";',
      'export { n };',
    ].join('\n');
    expect(findComments('a.mts', allowed)).toEqual([]);
    expect(findComments('a.mjs', '#!/usr/bin/env node\nexport const x = 1;\n')).toEqual([]);
  });

  it('rejects every suppression or tooling pragma', () => {
    const pragmas = [
      '// @ts-ignore',
      '// @ts-nocheck',
      '/* eslint-disable */',
      '// biome-ignore lint/style/useConst: reason',
      '// prettier-ignore',
      '/* istanbul ignore next */',
      '/* c8 ignore next */',
      '/* @ts-expect-error */',
    ];
    for (const pragma of pragmas) {
      expect(findComments('a.ts', `${pragma}\nexport const x = 1;\n`), pragma).toHaveLength(1);
    }
  });

  it('fails loudly on unparsable source instead of skipping it', () => {
    expect(() => findComments('a.ts', 'const = ;')).toThrow(/cannot parse/);
  });
});

describe('JSON', () => {
  it('ignores slashes inside strings, including escaped quotes', () => {
    const text = '{"$schema": "https://x/y", "s": "/* no */", "q": "\\"// no\\"", "p": "a//b"}';
    expect(findJsonComments(text)).toEqual([]);
  });

  it('reports JSONC comments', () => {
    const text = '{\n  // line\n  "a": 1, /* block */\n  "b": 2\n}\n';
    expect(lines(findJsonComments(text))).toEqual([2, 3]);
    expect(classifyFile('tsconfig.json')).toBe('json');
  });
});

describe('YAML', () => {
  it('ignores # inside quoted, plain and block scalars', () => {
    const text = [
      'a: "x # y"',
      "b: 'x # y'",
      'c: x#y',
      'd: |',
      '  # not a comment',
      '  text',
      'e: >-',
      '  # folded, still text',
      'url: https://example.com/#anchor',
      `run: echo "$#" ${DOLLAR}{#x}`,
      '',
    ].join('\n');
    expect(findYamlComments(text)).toEqual([]);
  });

  it('reports document, trailing, flow and block-header comments', () => {
    const text = [
      '# top',
      'a: 1 # trailing',
      'b: [1, # in flow',
      '  2]',
      'c: | # header',
      '  body',
      'd:',
      '  # nested',
      '  e: 2',
      '',
    ].join('\n');
    expect(lines(findYamlComments(text))).toEqual([1, 2, 3, 5, 8]);
  });
});

describe('shell', () => {
  it('ignores $#, brace expansions, quoted #, mid-word # and heredoc bodies', () => {
    const text = [
      '#!/usr/bin/env bash',
      `echo "$#" $# ${DOLLAR}{#x} ${DOLLAR}{x#prefix}`,
      "echo 'a # b' \"a # b\" $'a # \\' b'",
      'echo a#b x=#',
      'cat <<EOF',
      '# heredoc body',
      'EOF',
      'cat <<-"END"',
      '\t# tab-stripped body',
      '\tEND',
      'echo done',
      '',
    ].join('\n');
    expect(findShellComments(text)).toEqual([]);
  });

  it('reports full-line, trailing and post-operator comments', () => {
    const text = ['# full line', 'echo hi # trailing', 'true;# after operator', ''].join('\n');
    expect(lines(findShellComments(text))).toEqual([1, 2, 3]);
    expect(classifyFile('run', '#!/bin/sh\necho\n')).toBe('shell');
  });
});

describe('Dockerfile', () => {
  it('allows only a leading # syntax= directive', () => {
    expect(findDockerfileComments('# syntax=docker/dockerfile:1.7\nFROM node:22\n')).toEqual([]);
    expect(lines(findDockerfileComments('# escape=`\nFROM node:22\n'))).toEqual([1]);
    expect(lines(findDockerfileComments('FROM node:22\n# syntax=docker/dockerfile:1.7\n'))).toEqual(
      [2],
    );
  });

  it('ignores # in arguments and heredocs but reports comments and shell-form RUN comments', () => {
    const text = [
      'FROM node:22',
      'ENV A="#x" B=c#d',
      'LABEL note="a # b"',
      `RUN echo "#x" ${DOLLAR}{#PATH} \\`,
      '  && echo done',
      'COPY <<EOF /etc/motd',
      '# file content',
      'EOF',
      'CMD ["node", "#not-a-comment"]',
      '# real comment',
      'RUN echo hi # shell comment',
      'RUN apt-get update \\',
      '  # comment between continuation lines',
      '  && true',
      '',
    ].join('\n');
    expect(lines(findDockerfileComments(text))).toEqual([10, 11, 13]);
    expect(classifyFile('docker/proxy.Dockerfile')).toBe('dockerfile');
    expect(classifyFile('docker/proxy.Dockerfile.dockerignore')).toBe('hash-lines');
  });
});

describe('scope', () => {
  it('exempts Markdown and unknown file types', () => {
    expect(findComments('README.md', '<!-- html comment -->\n# Heading\n')).toEqual([]);
    expect(classifyFile('image.png')).toBeNull();
  });

  const dir = mkdtempSync(path.join(tmpdir(), 'no-comments-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('exits non-zero listing file:line, and zero when clean', () => {
    writeFileSync(path.join(dir, 'bad.ts'), 'export const a = 1; // nope\n');
    writeFileSync(path.join(dir, 'good.ts'), 'export const b = "// fine";\n');
    expect(() =>
      execFileSync(process.execPath, [script, 'bad.ts'], { cwd: dir, stdio: 'pipe' }),
    ).toThrow(/bad\.ts:1: \/\/ nope/);
    const out = execFileSync(process.execPath, [script, 'good.ts'], { cwd: dir, encoding: 'utf8' });
    expect(out).toMatch(/no comments/);
  });
});
