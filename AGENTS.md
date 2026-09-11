# Working on this repository

Read this before changing the CLI. README.md is the short package introduction;
`i-plane guide` and command help explain usage. `docs/api-coverage.md` records the
supported API surface, compatibility details and development checks.

## Purpose

A Plane CLI for coding agents and automation. Compact, predictable output is a
product requirement: callers should not need large REST responses or an
interactive terminal to understand and update their work.

Track CLI work in Plane project `IPL`. Server-side extension work belongs to
`PLX` in the sibling `for-plane` repository. Keep the public command contract and
its matching server requirements documented in `docs/pages.md`.

## Invariants

**Nothing prompts.** Missing arguments and invalid values raise `UsageError`
with an actionable hint. Never wait for interactive input.

**Exit codes are a contract.** Use `2` for an invalid call and `1` for an API or
connection failure. Do not classify a transport failure as invalid user input.

**Every command supports JSON.** Build an output model and pass it through
`printValue` in `src/output.ts`. Text and JSON must describe the same result.
Guide/help models include global options and usage notes as well as commands.

**The registry owns the CLI contract.** `src/registry.ts` declares command names,
aliases, arguments, options, required markers, examples, usage notes and next
steps. The parser derives value flags from it. Online handlers live in
`src/dispatch.ts`; the registry and handler table must agree in both directions.
Required markers document the contract; handlers still validate the arguments.

**Help is part of the implementation.** A new command needs a purpose, supported
fields, requirements, realistic examples and follow-up calls. Keep summaries
short; put decisions and limitations in usage notes. All example flags must be
accepted by that command. Do not advertise API/UI fields that the CLI cannot set.
Keep README concise and point readers to `guide` and `--help` for workflows.

**Never trust a server-side filter without checking it.** Use `fields`, `expand`
and pagination to limit wire size while collecting all pages. The work item
endpoint can accept state, priority and ordering filters without applying them;
those filters are handled in the client. Check behavior, not only HTTP status.

**Never let a token escape.** Register `guardSecret` before diagnostics. All
output goes through the guards in `src/output.ts`; client errors are redacted,
and config output uses `maskToken`. Redact before truncating or formatting.
A server response or a native error can echo credentials back.

**A successful write stays successful.** Resolve and validate inputs before
writing. Do not report a successful mutation as failed because an optional
follow-up read or setup step failed. Return the created identifier and a clear
warning with a recovery command. Do not automatically retry uncertain writes.

**Markdown has a defined scope.** Work item and intake descriptions, and comment
bodies, use Markdown converted at the API boundary. Project, label, state, cycle
and module descriptions are plain text. Keep the established `markdown-it` and
`turndown` conversion; raw HTML must remain escaped in Markdown input.

**Runtime and dependency claims must agree.** Support Node 22.21+ on the 22.x
line or Node 24+. Keep README and `package.json` engines consistent. Undici 8.x
requires Node 22.19+; the native proxy fallback requires Node 22.21 or Node 24.
Pin dependencies exactly and keep optional `undici` external to the bundle.
Do not infer minimum-version compatibility from a build on a newer runtime.

## API behavior that must survive changes

- Project names reject special characters, including hyphens. Validate before
  the creation request. API routes and defaults must be checked on the target
  server; newer UI documentation can describe different behavior.
- `--label` merges with existing labels; `--labels` replaces them. Plane replaces
  the whole labels array. Read-modify-write can still race with another editor.
- Resolve readable work item references and names before writes. Reject ambiguous
  matches, and validate project membership for bulk cycle/module assignment.
- `project create --intake` must initialize the queue with a project PATCH.
  Setting the creation flag alone can leave a missing queue and cause HTTP 500.
- Cycle updates preserve the existing owner when `--owner` is absent. Some
  servers otherwise default ownership to the requesting user.
- Cycle dates must be supplied or cleared together, including `none`. Format
  their timestamps in the project timezone; retain raw timestamps in JSON.
- A work item has one cycle but can belong to several modules. Cycle transfer
  moves unfinished work and leaves completed/cancelled work in the source.
- Expired snoozes may disappear from intake GET and normal triage lookup.
  Intake update/delete by work item UUID must not require a preliminary GET.
  If a readable reference cannot resolve, explain how to use saved `issueId`.
- Intake status is separate from work item state. Acceptance moves triage work
  to the project default state on the supported API path. Removing an accepted
  intake entry keeps the work item; removing an unaccepted entry deletes it too.

Regression history also includes infinite Markdown fence parsing, lost inline
HTML inside code, ignored unknown flags, and `--yes=false` confirming deletion.
Preserve coverage for these cases when refactoring.

## Checks

```bash
bun test
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/biome check .
node scripts/release.mjs
```

Tests cover regressions, registry/handler agreement, executable help examples,
request payloads, output and errors. A test that only accepts any exception or
checks that a function was called does not establish correct behavior.

TypeScript checks `src` and `types`; tests run under Bun. Do not add `bun-types`
to the project's TypeScript compilation just to include tests: its declarations
can conflict with `@types/node`. Exercise the built Node entry point too.

## Live checks

The CLI reads `~/.config/plane/credentials` itself. Keep secrets out of command
arguments and logs where possible. Use the local build when checking new code:

```bash
bun run build
node dist/cli.js list CLOUD
```

Prefer a short, targeted scenario for the behavior changed. Use a temporary
project for writes and remove it afterwards. Do not change working project data
as test fixtures. Preserve a created project's identifier if cleanup fails.

The full scripts `scripts/acceptance.mjs --live` and
`scripts/planning-acceptance.mjs --live` use real CLI commands and clean up their
projects in `finally`. They take several minutes because they space requests.
Do not repeat both scripts for a documentation edit or a narrow fix that can be
verified with a focused check. Respect the API request budget and use bounded,
observable waits. A forced termination can interrupt cleanup.

`EPERM`/`EACCES` before an HTTP response indicates an operating-system permission
failure. Check the selected proxy route and sandbox network access before
changing credentials or application code. An installed CLI can also differ from
the local build: check its version before diagnosing missing commands.

## Releases and tracking

Keep `package.json` and `src/cli.ts` versions in sync. The release gate empties
`dist`, runs checks, builds, smoke-tests the command, validates the exact package
contents and size, and checks registry availability. Changes to shipped files
must update both `package.json` files and the gate's allowlist.

Publishing is irreversible. `node scripts/release.mjs` does not publish;
`--publish` is the publishing path. Obtain authorization for publication and
reuse it within the authorized release rather than asking repeatedly.

A successful npm upload can return HTTP 202 while registry processing continues.
Do not republish the same version or treat a transient post-upload 404 as a
failed upload. Distinguish submission from public availability, use short bounded
checks, and verify the published version and `latest` tag before claiming both
are available.

Keep project task statuses aligned with the work. Move a task into progress when
starting, close it after its checks, and reopen it when a confirmed review finding
invalidates completion. Report whether a change is local, installed or published;
these are separate states. Keep implementation and public product documentation
provider-neutral; follow the shared authorship policy for commit trailers.

## Page command invariants

Page commands use AutoPageClient; other commands retain PlaneClient. Prefer the
public API-key page list and load session configuration lazily only after selecting
the native fallback. A list 404 requires checking runtime capabilities; 401/403,
server/transport failures and detail-page 404 must never select fallback. Cache
capabilities per instance, never permissions, with bounded expiry and explicit
refresh. Keep config diagnostics offline and accurate about an unknown selection.

The session path supports password sign-in and private cookie caching for stock
Plane. Refresh once only on a definite HTTP 401 or live authentication refusal
before synchronization; never retry uncertain writes or replay a live mutation.
API-key access must not resolve session credentials. Load Yjs, the live provider,
WebSocket and session dependencies lazily, with exact live versions external in
both build paths. Guard every credential and its serialized forms before output.
The API-key live connection sends explicit read/write intent and the current
runtime release; session live connections include a release when one is present.

Live success means acknowledged delivery, not a database commit. Never replay a
mutation automatically. Complete asynchronous conversion before resolving a
block anchor and checking its content fingerprint inside one transaction. Read
commands never stamp. Only page stamp assigns missing top-level anchors.

--yes confirms deletion; --force bypasses a stale fingerprint; --allow-loss
accepts reported conversion losses. These decisions must stay separate. Empty
--block must fail before a whole-page mutation can be selected.

Page fixtures and wire tests live under tests/page*. Unsupported rich content
must remain visible or produce an explicit loss warning.

Knowledge review blocks use the reserved `knowledge-review` fenced JSON format.
Preserve date/source values through a real converter round trip. Invalid dates,
unknown input fields and lost rich content must fail or report explicit losses.
Keep `scripts/page-mutations.mjs` able to detect broken transformations.
