# Working on this repository

Read this before changing anything here. It is not documentation of what the tool
does — that is `README.md` — it is what breaks when the rules below are ignored.

## What this is

A CLI for [Plane](https://plane.so) whose caller is a coding agent, not a person
at a terminal. Plane's REST answer for seven work items is ~6,500 tokens of JSON;
this prints ~145 tokens of lines. Every rule below follows from that one fact.

## Authorship

Written by Claude (Anthropic) with the repository owner. The owner decides what
gets built and what ships; the model writes the code, runs the checks, and
reports what it finds — including when the finding is its own bug.

## Invariants

Breaking one of these is a bug even when tests pass.

**Nothing prompts, ever.** A CLI that waits for input hangs an agent forever. A
missing argument is a `UsageError` naming what was expected; `src/commands/guide.ts`
turns it into a hint with that command's real examples.

**Exit codes are a contract.** `2` the call was wrong, `1` Plane refused or was
unreachable. Callers branch on the code instead of parsing text, so a
misclassified error is worse than a vague message.

**`--json` is never optional.** Commands build a model and hand it to a formatter;
`printValue` in `src/output.ts` decides between them. Print directly and you have
silently dropped `--json` for that command.

**`src/registry.ts` is the single source for commands.** It feeds the guide, every
`<command> --help`, and the hint on a failed call — and it is what rejects unknown
flags. Add a flag to a command without adding it there and the CLI will refuse it.

**Never trust a server-side filter.** The list endpoint honours `fields` and
`expand` (11 KB → 737 bytes on the wire) but accepts `state_group`, `priority` and
`order_by` with a 200 and ignores them. Narrowing happens in `src/commands/issues.ts`.

**Never let the token reach text.** `redact` in `src/client.ts` guards every error
path; `maskToken` guards `config`. Node puts an offending header value into its
own error message, and a server can echo a key back in an error body.

**Pin versions exactly.** A range once meant the tree tested here and the tree a
user installs were different — undici, `^7.16.0` against 8.10.2 installed.

## Ground already lost once

Twenty-one findings came out of one review. These are the ones worth remembering:

| What happened | Why |
|---|---|
| ` ```c++ ` hung the process forever | a fence pattern that refused a line without consuming it |
| `--yes=false` deleted a work item | a switch tested for presence, not value |
| a misspelled `--priority` returned an unfiltered list, exit 0 | no flag validation |
| the API token appeared in an error message | masking guarded one command, not the error paths |
| a description lost `<div>` inside inline code | entity decoding followed by tag stripping |

The Markdown conversion was hand-written and lost five ways at once. It now uses
`markdown-it` and `turndown`. `markdown-it` rather than `marked` for one reason:
with `html:false` it escapes raw HTML instead of passing `<img src=x onerror=…>`
into other people's browsers.

## Checks

```bash
bun test                              # every case is a bug that shipped once
./node_modules/.bin/tsc --noEmit      # src and types; tests are checked by bun
./node_modules/.bin/biome check .
node scripts/release.mjs              # the full gate, without publishing
```

Tests are deliberately not in `tsc`'s `include`: pulling `bun-types` in collides
with `@types/node` inside the library's own declarations, and a type error in
someone else's file says nothing about this code.

## Testing against a live instance

Credentials are at `~/.config/plane/credentials` and the CLI reads them itself, so
`node dist/cli.js list CLOUD` works with no arguments. Delete anything you create:

```bash
node dist/cli.js delete CLOUD-42 --yes
```

## Releasing

Publishing is irreversible — a version cannot be reused, and a tarball that
shipped too much stays in every mirror. `node scripts/release.mjs` does
everything except publish; `--publish` is the only path to `npm publish`. The gate
empties `dist`, runs the checks, smoke-tests the built command, enforces package
contents and size, and refuses when the registry cannot be reached.
