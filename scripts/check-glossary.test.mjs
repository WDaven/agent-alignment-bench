import { describe, expect, it } from 'vitest';
import { checkGlossaries, exampleResolves, parseGlossary, splitWords } from './check-glossary.mjs';

const HEADER = '| Term | Meaning | Used in names as | Avoid |\n| --- | --- | --- | --- |';
const row = (term, meaning, used, avoid = '') =>
  `| \`${term}\` | ${meaning} | ${used} | ${avoid} |`;

const ROOT = [
  '# AGENTS.md',
  '',
  'Preamble.',
  '',
  HEADER,
  row('attempt', 'One journaled call.', '`attemptId`', '`try again`'),
  row('episode', 'One execution.', '`packages/x/`', ''),
  '',
].join('\n');

const NESTED = [
  '# Domain glossary',
  '',
  HEADER,
  row('ledger', 'Money state.', '`ledgerTotal`'),
  '',
].join('\n');

const SOURCE = 'export const attemptId = 1;\nexport function ledgerTotal() { return attemptId; }\n';

function repo(overrides = {}) {
  const contents = {
    'AGENTS.md': ROOT,
    'packages/x/AGENTS.md': NESTED,
    'packages/x/src/index.ts': SOURCE,
    ...overrides,
  };
  const files = Object.keys(contents).filter((f) => contents[f] !== undefined);
  return checkGlossaries({ files, read: (f) => contents[f] ?? null });
}

describe('splitWords', () => {
  it('splits camel, Pascal, snake, kebab and acronym boundaries', () => {
    expect(splitWords('validateEventLog')).toEqual(['validate', 'event', 'log']);
    expect(splitWords('ACTION_CATALOG')).toEqual(['action', 'catalog']);
    expect(splitWords('HTTPSProxy')).toEqual(['https', 'proxy']);
    expect(splitWords('run-dir')).toEqual(['run', 'dir']);
  });
});

describe('parseGlossary', () => {
  it('accepts the root shape and the nested shape', () => {
    expect(parseGlossary('AGENTS.md', ROOT, { isRoot: true }).problems).toEqual([]);
    expect(parseGlossary('a/AGENTS.md', NESTED, { isRoot: false }).problems).toEqual([]);
  });

  it('rejects prose in a nested file and content after the table', () => {
    const prose = NESTED.replace('# Domain glossary', '# Domain glossary\n\nRun pnpm test.');
    expect(parseGlossary('a/AGENTS.md', prose, { isRoot: false }).problems[0]).toMatch(
      /nothing else/,
    );
    const trailing = `${ROOT}\n## More\n`;
    expect(parseGlossary('AGENTS.md', trailing, { isRoot: true }).problems[0]).toMatch(/follow/);
  });

  it('requires the exact columns, non-empty cells and alphabetical order', () => {
    const wrongColumns = NESTED.replace('| Avoid |', '| Synonyms |');
    expect(parseGlossary('a/AGENTS.md', wrongColumns, { isRoot: false }).problems.join()).toMatch(
      /columns/,
    );
    const empty = NESTED.replace('Money state.', '').replace('`ledgerTotal`', '');
    const problems = parseGlossary('a/AGENTS.md', empty, { isRoot: false }).problems.join('\n');
    expect(problems).toMatch(/Meaning is empty/);
    expect(problems).toMatch(/no backticked example/);
    const unsorted = ROOT.replace('`attempt`', '`zebra`');
    expect(parseGlossary('AGENTS.md', unsorted, { isRoot: true }).problems.join()).toMatch(
      /alphabetical/,
    );
  });

  it('caps the root preamble', () => {
    const long = ROOT.replace(
      'Preamble.',
      Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
    );
    expect(parseGlossary('AGENTS.md', long, { isRoot: true }).problems.join()).toMatch(/preamble/);
  });
});

describe('checkGlossaries', () => {
  it('passes a consistent repo', () => {
    expect(repo()).toEqual([]);
  });

  it('rejects a term defined in two files', () => {
    const dup = NESTED.replace('`ledger`', '`attempt`');
    expect(repo({ 'packages/x/AGENTS.md': dup }).join()).toMatch(/already defined/);
  });

  it('rejects examples that do not exist', () => {
    const bad = NESTED.replace('`ledgerTotal`', '`ledgerSum`');
    expect(repo({ 'packages/x/AGENTS.md': bad }).join()).toMatch(/ledgerSum.*not found/);
  });

  it('rejects avoided words in identifiers and paths, matching whole word parts', () => {
    const avoidLedger = NESTED.replace(
      row('ledger', 'Money state.', '`ledgerTotal`'),
      row('ledger', 'Money state.', '`ledgerTotal`', '`total`'),
    );
    expect(repo({ 'packages/x/AGENTS.md': avoidLedger }).join()).toMatch(/"total".*ledgerTotal/);
    const src = `${SOURCE}export const tryAgainLater = 2;\n`;
    expect(repo({ 'packages/x/src/index.ts': src }).join()).toMatch(/"try again"/);
    expect(repo({ 'packages/x/src/try-again.ts': 'export {};\n' }).join()).toMatch(/path/);
    const partial = `${SOURCE}export const retry = 3;\n`;
    expect(repo({ 'packages/x/src/index.ts': partial })).toEqual([]);
  });

  it('ignores avoided words inside string literals', () => {
    const src = `${SOURCE}export const message = 'try again later';\n`;
    expect(repo({ 'packages/x/src/index.ts': src })).toEqual([]);
  });

  it('requires kebab-case folders and a root glossary', () => {
    expect(repo({ 'packages/x/src/__tests__/a.ts': 'export {};\n' }).join()).toMatch(/kebab-case/);
    expect(repo({ 'AGENTS.md': undefined }).join()).toMatch(/missing at root/);
  });
});

describe('exampleResolves', () => {
  it('matches whole names, paths and strings but not substrings', () => {
    const ctx = { paths: new Set(['docs', 'docs/a.md']), corpus: "const x = 'action.attempted';" };
    expect(exampleResolves('docs/', ctx)).toBe(true);
    expect(exampleResolves('action.attempted', ctx)).toBe(true);
    expect(exampleResolves('action', ctx)).toBe(true);
    expect(exampleResolves('attempt', ctx)).toBe(false);
  });
});
