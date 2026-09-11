# API coverage

Paths below are relative to `/api/v1/workspaces/{workspace_slug}/`. The command
registry defines the supported CLI surface, including value flags and aliases;
`tests/registry.test.ts` checks it against the dispatch table and exercises the
actual handlers. `tests/cli.test.ts` verifies the entry point's flag validation.

| Resource | Supported operations | CLI |
| --- | --- | --- |
| Projects | GET/POST `projects/`; PATCH/DELETE `projects/{project}/`; POST `projects/{project}/archive/` | `projects`, `project create`, `project update`, `project rm`, `project archive` |
| Work items | GET/POST `projects/{project}/issues/`; GET/PATCH/DELETE `projects/{project}/issues/{issue}/`; GET `issues/{ref}/` | `list`, `create`, `show`, `update`, `done`, `delete` |
| Work item fields | `parent`, `assignees`, `labels`, `start_date`, `target_date`, `name`, `state`, `priority`, `description_html` | `create` and `update` flags; `done` forwards update fields except state |
| Labels | GET/POST `projects/{project}/labels/`; DELETE `projects/{project}/labels/{label}/` | `labels`, `label create`, `label rm` |
| States | GET/POST `projects/{project}/states/`; PATCH/DELETE `projects/{project}/states/{state}/` | `states`, `state create`, `state update`, `state rm` |
| Comments | GET/POST `projects/{project}/issues/{issue}/comments/` | `comments`, `comment`, `show --comments` |
| Cycles | GET/POST `projects/{project}/cycles/`; PATCH `projects/{project}/cycles/{cycle}/`; GET `projects/{project}/cycles-lite/`; GET/POST `projects/{project}/cycles/{cycle}/cycle-issues/`; POST `projects/{project}/cycles/{cycle}/transfer-issues/` | `cycles`, `cycle create`, `cycle update`, `cycle add`, `cycle issues`, `cycle transfer` |
| Modules | GET/POST `projects/{project}/modules/`; GET `projects/{project}/modules-lite/`; GET/POST `projects/{project}/modules/{module}/module-issues/` | `modules`, `module create`, `module add`, `module issues` |
| Intake | GET/POST `projects/{project}/intake-issues/`; GET/PATCH/DELETE `projects/{project}/intake-issues/{issue}/` | `intake list`, `intake create`, `intake show`, `intake update`, `intake rm` |
| Project features | `cycle_view`, `module_view`, `intake_view` on project POST/PATCH | `project create` and `project update`: `--cycles`, `--modules`, `--intake` |
| Search | GET `issues/search/` | `search` |
| Members | GET `members-lite/` | `members`, named assignee resolution |
| Current user | GET `/api/v1/users/me/` | `whoami` |
| Summary | GET `projects/{project}/summary/` | `summary` |

The compatibility target uses the `issues/` routes. The current public
[work item reference](https://developers.plane.so/api-reference/issue/overview)
documents `work-items/` instead. A route migration must be verified against the
target server; do not change paths solely to match a newer documentation release.

## What modules and intake are for

A module groups work toward a feature, milestone or other goal and may span
several cycles. A cycle is a time window. Work items can belong to multiple
modules. A module's lead and members are separate from work item assignees.
The module status describes its overall planning stage; work item states show
individual progress. See [Plane's module guide](https://docs.plane.so/core-concepts/modules).

Intake is a queue for reports and requests that have not yet been accepted into
project work. Requests start in Triage with a pending decision. They can be
accepted, rejected, snoozed or linked to an existing work item as a duplicate.
This keeps undecided requests out of committed work. See the
[intake overview](https://docs.plane.so/intake/overview).

| Resource | Plane fields | Current CLI support |
| --- | --- | --- |
| Module | Name, description, overall status, start/due dates | `module create` with name, `--description`, `--status`, `--start`, `--due` |
| Module ownership | Lead and members | Available in the API/UI; not set by this CLI |
| Module contents | Related work items | `module add`, `module issues`; membership can overlap across modules |
| Intake request | Title, description, priority | `intake create`; `intake update --name`, `--description`, `--priority` |
| Intake decision | Pending, rejected, snoozed, accepted, duplicate; snooze deadline; duplicate target | `intake update --status`, `--snooze-until`, `--duplicate-of` |
| Intake work properties | Assignees, labels, due date and other UI properties | Not exposed by intake commands; use normal `update` after acceptance |
| Intake channels | In-app submissions, public forms, email | CLI submits through the API; it does not configure forms/email |

The UI guide and API defaults are not interchangeable. The module guide says
new modules start in Backlog, while the tested API instance returned `planned`
when status was omitted. CLI examples therefore specify `--status planned`.
The UI can choose a work item state while accepting an intake request; the
current CLI/API acceptance path moves it to the default project state. A normal
`update --state` can then select a different state.

A focused check of the published CLI confirmed that adding a work item to a
second module preserves its first membership, and that intake acceptance moves
a request from pending/Triage into the normal Backlog state on the tested
instance. Temporary check data was deleted.

Field references: [module creation](https://developers.plane.so/api-reference/module/add-module),
[intake properties](https://docs.plane.so/core-concepts/intake), and
[intake updates](https://developers.plane.so/api-reference/intake-issue/update-intake-issue-detail).

## Compatibility details

The supported runtime is Node 22.21+ on the 22.x line, or Node 24+. The optional
proxy dependency, `undici` 8.x, requires Node 22.19 or newer. The fallback based
on `NODE_USE_ENV_PROXY` requires Node 22.21 or Node 24; the package's `engines`
range covers both transport paths. Node 20 is not a supported configuration.
See [Undici support](https://github.com/nodejs/undici#long-term-support) and
[Node proxy support](https://nodejs.org/api/cli.html#node_use_env_proxy1).

Enabling intake on project creation requires a follow-up project PATCH to create
the queue. A creation flag alone can leave `intake_view=true` without an intake
record, causing the first submission to fail with HTTP 500. The CLI initializes
the queue explicitly and reports partial setup without encouraging a duplicate
project creation.

Cycle updates explicitly preserve `owned_by` when no owner is supplied: some
servers otherwise default it to the requesting user. Calendar dates are formatted
in the project's timezone; the JSON model keeps the API timestamps.

Expired snoozes can be filtered out of intake GET and ordinary triage work item
lookup. Update and delete therefore accept underlying work item UUIDs without
requiring an intake GET. A hidden readable reference cannot be resolved by these
API endpoints; the diagnostic points to `issueId` from an earlier JSON response.

## Remaining gaps

- Label updates and comment updates/deletions are not exposed.
- Cycle/module archive, delete and membership removal are not exposed; module
  details cannot yet be edited. The planning tasks cover listing, creation,
  membership and cycle transfer.
- This is an inventory of the implemented surface, not a claim to cover every
  endpoint in every edition of Plane.

## Project pages

`pages` and `page show` automatically select API-key or native session page access. `page outline`, `page read`,
`page stamp`, `page create`, `page set`, `page insert` and block removal use the
live document protocol. Whole-page deletion uses the selected page endpoint. See the
[page workflow](pages.md) for credentials, fingerprints, formatting losses and
asynchronous persistence. This internal API can change independently of Plane's
public API; compatibility is covered by converter fixtures and live acceptance.

## Adding a command

1. Add the command and all options to `src/registry.ts`. The parser gets value
   flags from the registry, including those of multiword commands.
2. Add an online handler to `src/dispatch.ts` or a page handler to `src/page-dispatch.ts`. Both missing handlers and handlers
   absent from the registry fail the command-set test.
3. Add a fixture invocation and valid option values to the registry suite. Test
   the requested method, path and body, and assert observable output. Merely
   accepting a flag in `--help` is insufficient.
4. Extend the live acceptance script when the command contributes to project
   setup. Verify writes by reading them back, and clean up temporary data.
5. Update this table and README examples.

Reference: [projects](https://developers.plane.so/api-reference/project/add-project),
[labels](https://developers.plane.so/api-reference/label/add-label),
[states](https://developers.plane.so/api-reference/state/add-state),
[cycles](https://developers.plane.so/api-reference/cycle/transfer-cycle-work-items),
[modules](https://developers.plane.so/api-reference/module/add-module),
[intake](https://developers.plane.so/api-reference/intake-issue/overview).

## Development checks

From a repository checkout:

```bash
bun test
bun run check
bun run lint
node scripts/release.mjs
```

The release gate builds and checks the distributable, smoke-tests the command,
and validates package contents, size and registry availability. Its default run
does not publish; `--publish` is the publishing path.

For live acceptance, build first and use the normal Plane credentials:

```bash
bun run build
node scripts/acceptance.mjs --live
node scripts/planning-acceptance.mjs --live
node scripts/pages-acceptance.mjs --live --project APP
```

The first script creates an epic and nine children, then checks labels,
assignment, dates, comments, states and archive. The second checks cycles,
unfinished-work transfer, module membership and the intake lifecycle. Both use
CLI commands and delete their temporary projects in a `finally` block.
They space calls to respect the API request budget and take several minutes;
a forced termination can interrupt cleanup. For a focused change, prefer a
small targeted live check to repeating both scenarios.

The page acceptance script creates and removes one page in the selected existing
project. It exercises all nine commands and observes saved HTML within a bounded
window; that window is a test limit, not a persistence guarantee. Run
`node scripts/page-mutations.mjs` for isolated mutation checks.

### Automatic page transport

`AutoPageClient` probes the public project-page list, prefers API-key access and
selects the native session API only when the route is absent and runtime
configuration does not advertise API-key pages. Permission failures and individual
page `404` responses never cause fallback. Capabilities are cached per instance
for five minutes, with `--refresh-pages` for immediate redetection. Config output
explains the cached selection without network access or loading session settings.

The session implementation and credentials load lazily. Session-only page access
remains supported; ordinary commands still require the public API key. A definite
HTTP `401` may refresh session authentication once; live may refresh once only
before synchronization. Live mutations are never replayed. API-key access never
refreshes through password sign-in. Both paths keep conversion on their selected
HTTP transport and reject redirects to avoid forwarding credentials.

Tests cover both identities, cache isolation/expiry/reset, installation transitions,
missing credentials, permission failures, redaction, session refresh and live
handshakes. See [pages.md](pages.md) for configuration and cache paths.

Run `node scripts/page-mutations.mjs` to check that the page tests detect intentional
regressions. `scripts/page-key-acceptance.mjs` exercises a built CLI against an
isolated deployment using a private test fixture and a browser. It creates a page,
checks both writers, stale fingerprints and deletion, then removes the test page.
The package ships command help and user documentation; repository-only contributor
instructions are excluded from the release archive.

### Automatic transport verification

The built Node CLI passed all nine page commands against isolated Plane 1.4.2
instances both with API-key pages enabled and with the official, unmodified
backend/live images. Each run verified live editing, stale fingerprints, language
preservation, saved HTML and cleanup. The stock instance also passed session-only
access without an API key. No production rollout or npm publication was performed.

The release dry run passed 1,318 tests, TypeScript, formatting, Node smoke checks,
lazy dependency loading and package inventory checks. Nine deliberate mutations
were detected, including permission-triggered fallback and non-expiring capability
selection. These checks cover IPL-24; they do not resolve the separate PLX-11 review
findings in the extension layer and whole-page review conversion.

### Review follow-up verification

Saved page reads preserve semantic review fences and can restore older sanitized
HTML from canonical JSON by block ID. Invalid or unmatched metadata, unsupported
wrappers, stale review order and malformed tables produce explicit losses.
A real built-CLI `page show` to file to `page set` round trip passed with exact
review date/source retained after browser reload. Unsupported underline content
reported a read loss and refused replacement without `--allow-loss`.

Late capability removal now repeats reference resolution before any mutation;
HTTP and live mutation markers prevent replay once a write has started. Targeted
independent reviews of formatting and command targeting found no remaining
confirmed issues. The complete release dry run passed 1,338 tests and twelve
intentional mutation checks. The aggregate extension review remains separately
tracked in PLX-12; these results do not claim production deployment or publication.
