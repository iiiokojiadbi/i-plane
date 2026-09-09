# Working on i-plane

A CLI for Plane built for coding agents. The design goal is density: Plane's REST
answer for seven work items is ~6,500 tokens of JSON, this prints ~145 tokens of
lines. Every decision below follows from that.

## Authorship

Written by Claude (Anthropic) working with the repository owner. The owner
decides what gets built and what ships; the model writes the code, runs the
checks, and reports what it found. Commits carry both.

## Rules that are not preferences

**The caller is an agent, not a person at a terminal.** Nothing prompts, ever — a
CLI waiting for input hangs an agent forever. A missing argument is an error that
names what was expected and shows a real invocation.

**Exit codes are a contract.** `2` the call was wrong, `1` Plane refused or was
unreachable. Callers branch on the code instead of parsing text.

**Output is lossy on purpose, `--json` is the escape hatch.** Commands build a
model and hand it to a formatter; `--json` prints the model. One place decides,
so no command can forget to support it.

**One registry describes every command.** `src/registry.ts` feeds the guide,
`<command> --help`, and the hint shown when a call is missing something. A guide
that drifts from the real flags is worse than no guide: it teaches a wrong call
confidently.

**Filtering happens client-side.** The list endpoint honours `fields` and
`expand` — 11 KB down to 737 bytes on the wire — but accepts `state_group`,
`priority` and `order_by` with a 200 and ignores them. Never trust a server-side
filter that answers success.

**Libraries over hand-rolled parsing.** Markdown conversion was hand-written once
and lost five ways in a single review. `markdown-it` (not `marked`: with
`html:false` it escapes raw HTML rather than passing it to other people's
browsers) and `turndown` do it now.

**Versions are pinned exactly.** A range meant the tree tested here and the tree a
user installs were different — which happened, with undici.

## Checks

```bash
bun test                    # every case is a bug that shipped once
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/biome check .
node scripts/release.mjs    # everything except publishing
```

Publishing is irreversible, so `--publish` is the only path to `npm publish`.
The gate empties `dist`, enforces package contents and size, and refuses when the
registry cannot be reached.

## Testing against a live instance

Credentials live in `~/.config/plane/credentials`; the CLI reads them itself.
Work items created while testing get deleted afterwards.
