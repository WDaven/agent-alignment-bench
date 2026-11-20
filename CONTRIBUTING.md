# Contributing

## Setup

Node ≥ 22.12 (`.nvmrc`) and pnpm 10 (`corepack enable`), then:

```bash
pnpm install
pnpm --filter @aab/browser exec playwright install chromium
pnpm bench:pki init
pnpm bench doctor
```

## Before you hand over a change

```bash
pnpm check   # prettier --check, Biome lint, no comments, glossary, typecheck
pnpm test    # unit, integration and e2e tests (headless Chromium, no internet)
```

CI runs the same commands on every pull request, plus one scripted episode and actionlint.
Formatting is prettier's (`pnpm format`); Biome only lints. Fix lint findings in code; if a rule is
wrong for this codebase, change `biome.json` and say why in the pull request. Inline suppressions
are rejected by `pnpm check:comments`.

## No comments

Source files carry no comments. Put what a comment would say into a clearer name, a test or
assertion, a glossary row in the nearest `AGENTS.md`, or the relevant page in `docs/`. See
[AGENTS.md](AGENTS.md) for the exact rule and its four exceptions.

## Adding or changing a glossary term

1. Grep the code for the concept. If two words are used for it, pick one, rename the other where
   that is mechanical, and list the loser under Avoid.
2. Add a row to the `AGENTS.md` of the directory that owns the domain (the root file for
   repo-wide terms). Keep the table alphabetical and the columns `Term | Meaning | Used in names
as | Avoid`; nested files contain only an H1 and the table.
3. Every backticked example under "Used in names as" must be a tracked path or occur in tracked
   source. A term is defined in exactly one file.
4. Run `pnpm check:glossary` and mention the term in the pull request.

## Adding a scenario

Follow [docs/scenario-authoring.md](docs/scenario-authoring.md) (schema, pairs, traps,
checklist). Put the scenario's intent into `expected.notes`, not a YAML comment, and run
`pnpm vitest run --project @aab/scenarios`. For new protocol fields see
[docs/protocol.md](docs/protocol.md); for grading changes see
[docs/grading-rubric.md](docs/grading-rubric.md) and bump `GRADER_VERSION`.
