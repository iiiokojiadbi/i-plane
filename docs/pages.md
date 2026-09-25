# Project and wiki pages

Read project knowledge as Markdown, then change a section without rewriting the
rest of the document. Page metadata uses an automatically selected API-key or session endpoint; content
changes use the collaborative live editor.

## Workspace wiki

Use `wiki` in place of `page`, omitting the project argument. The selected
workspace comes from the usual configuration or `--workspace`:

```bash
i-plane wiki list
i-plane wiki show "Release notes"
i-plane wiki create --name "Release notes" --file release.md
i-plane wiki create --name "Deployment" --parent "Release notes"
i-plane wiki outline "Deployment"
i-plane wiki stamp "Deployment"
i-plane wiki read "Deployment" --block a1b2c3d4 --json
i-plane wiki set "Deployment" --block a1b2c3d4 --if-match "$FINGERPRINT" --text "Updated paragraph"
i-plane wiki insert "Deployment" --at-end --file appendix.md
i-plane wiki rm "Deployment" --block a1b2c3d4 --yes
```

All editing flags have the same meaning as for project pages: `--if-match`,
`--force`, `--allow-loss`, `--yes`, `--file`, `--text` and `--json`. Both placements
share the Markdown/Yjs conversion, block editing, reader preservation checks and
delivery semantics below. Project command syntax and behavior are unchanged.

Wiki requires an API key and enabled `workspace-wiki` and `api-key-pages` modules.
Commands check runtime support before accessing pages and refuse unsupported
servers with exit code 1. Missing key configuration is a usage error (exit 2).
Wiki commands do not attempt session sign-in or project routes. Live uses
`workspace_page` without `projectId`. Reader capabilities reuse the common cache
implementation with a separate wiki entry, so a cached project session cannot
change the wiki identity. Runtime support is rechecked on every invocation;
permissions are never cached. `--refresh-pages` bypasses retained capabilities,
and `config --refresh-pages` clears both placement entries.

`wiki list` includes all accessible pages, including nested and archived pages;
project `pages` also includes archived pages. Text shows UUID, name, parent UUID
and modification date. JSON retains the server metadata and makes `parent`
explicit as a UUID or `null`. No parent name or invented parent is supplied.
Parents precede children; siblings sort by native manual `sort_order`, then
`created_at` and UUID. Missing parents appear among roots while keeping their
returned parent UUID. Legacy cycles appear once, in deterministic order.

Names resolve by exact match or unique prefix across that complete list;
ambiguous matches report candidate names and UUIDs. `wiki create --parent`
resolves its parent before creating the page. Omit the flag to create a root.
Reordering and moving existing pages are outside this command set.

Whole-page `wiki rm <page> --yes` sends deletion to the server **without archiving
automatically**. Archive the page in Plane first. The server permits deletion only
to the owner or a workspace administrator; refusals retain their explanation.
Block deletion uses live and does not archive or delete the page itself.
PDF export is not provided by either command family.

## Connect

Configure the same settings used for work items:

```ini
PLANE_URL=https://plane.example.com
PLANE_WORKSPACE=workspace
PLANE_API_KEY=your-api-key
```

The CLI first tries the public project-page list with the API key. With the
for-plane API-key pages extension enabled, HTTP and live use that key. Login,
password and session-cache settings are not resolved or loaded on this path.
The server derives identity and checks page permissions; read commands request
read-only live access. Both transports honor `HTTPS_PROXY`, `HTTP_PROXY` and
`NO_PROXY`.

On stock Plane, a missing public list route selects the native session API.
Configure these additional values in the credentials file or environment:

```ini
PLANE_LOGIN=reader@example.com
PLANE_PASSWORD=your-password
```

Password sign-in must be enabled on the server. Session-only page access also
works without an API key; other commands still require one. The CLI reports
missing session settings before attempting sign-in. Session cookies are cached
privately (directory mode 700, file mode 600), keyed by instance URL and login.
`PLANE_SESSION_CACHE` or `--session-cache <directory>` changes their location;
the default is `$XDG_CACHE_HOME/i-plane/sessions` or `~/.cache/i-plane/sessions`.
Passwords are never stored in the cookie cache.

### Detection and diagnostics

`i-plane config` is offline: it reports settings, masks the API key and shows the
cached page access path, its reason and expiry. Before the first page command,
or after expiry, it reports `unknown` rather than claiming a network check.

Capability detection is cached per instance URL for **five minutes**, independently
of the cookie cache. The cache contains no credentials. It defaults to
`$XDG_CACHE_HOME/i-plane/page-transports` or `~/.cache/i-plane/page-transports`;
`PLANE_PAGE_CACHE` can override the directory. Missing, expired, invalid or
unwritable cache files do not prevent detection. After installing extensions,
force immediate discovery with `i-plane pages APP --refresh-pages`, or clear the
selection with `i-plane config --refresh-pages`. No manual transport switch is needed.
A newly configured key rechecks a selection previously made without a key.

A `401`, `403`, network failure or server error never selects session fallback.
Only a page **list** `404` triggers a capability check; a missing individual page
stays a missing page. If the runtime reports API-key pages enabled, even a list
`404` remains an access/project error. An absent runtime route or explicitly
unavailable API-key feature permits the session path. Cached choices can remain
stale within the five-minute window; use `--refresh-pages` after server changes.

The session path refreshes authentication once on an HTTP `401` or a definite
live authentication refusal **before synchronization**. Other errors do not retry.
Live content changes and uncertain writes are never replayed automatically.
Stock Plane determines the permissions of session live connections; the CLI's
read commands do not mutate documents. API-key connections require the current
runtime release; session live connections negotiate it too when present. An adapter
with no installed runtime package retains stock session live access. When detection
changes the identity to a session user, project references are resolved again under
that user before reading or writing pages, so cold and cached commands target the
same project. If a cached API-key route disappears during a list read, the command
resolves its original references again before any mutation. An HTTP or live
mutation that has started is never replayed.

## Read, inspect, edit

```bash
i-plane pages APP
i-plane page show APP "Release notes"
i-plane page outline APP "Release notes"
```

Pages accept a UUID, exact name or unique name prefix. Outline reads the live
document and shows top-level index, eight-character anchor prefix, node kind and
40-character preview. Neither reading command writes anchors. When an existing
page has missing anchors, assign them explicitly:

```bash
i-plane page stamp APP "Release notes"
i-plane page outline APP "Release notes"
i-plane page read APP "Release notes" --block a1b2c3d4 --json
```

Use an actual anchor from outline. Copy the returned `fingerprint` into the next
command; it hashes block content, while the anchor remains stable across edits:

```bash
i-plane page set APP "Release notes" --block a1b2c3d4 \
  --if-match "$FINGERPRINT" --text "Updated paragraph"
i-plane page insert APP "Release notes" --after a1b2c3d4 --text "Another paragraph"
i-plane page insert APP "Release notes" --at-end --file appendix.md
i-plane page rm APP "Release notes" --block a1b2c3d4 --if-match "$FINGERPRINT" --yes
```

Read a fresh fingerprint before each edit. A stale fingerprint refuses the
change. `--force` explicitly bypasses that check. Without `--if-match`, a block
edit uses the latest live content. A replacement's first block inherits the
anchor; any additional blocks get new anchors. Repeating a command can produce
additional changes: commands are never automatically replayed.

## Create, replace, remove

```bash
i-plane page create APP --name "Release notes" --file release.md
i-plane page set APP "Release notes" --file revised-release.md
i-plane page rm APP "Release notes" --yes
```

`--file` and `--text` are mutually exclusive. Creation without either produces an
empty page. Creation with content uses two steps; an error after creation names
the new page UUID so you can recover without creating a duplicate. Empty content
clears a whole page, but empty block replacement or insertion is refused. Use
`page rm --block` for a block deletion. Page deletion always requires `--yes`. Plane requires archiving first; the CLI
archives and then deletes the page. If deletion fails, the error reports the
archived page UUID so you can inspect and recover it.
Nested pages can be read and edited by UUID. Listing returns root pages; name
resolution uses that list. The CLI does not expose a `--parent` option.

## Delivery and formatting

Successful editing means **the live server acknowledged delivery**. It does not
confirm a database commit. `page show` reads saved HTML, preserves semantic review fences and reports unsupported rich content in JSON `losses` and stderr warnings. It can immediately show
the previous content: persistence usually takes about ten seconds, with no
guaranteed upper bound. Use `page outline` and `page read` to check the immediate
live result. An interrupted write without an acknowledgement reports uncertain
delivery; inspect the live document before deciding whether to retry.

Markdown supports headings, paragraphs, lists, code, links, images and tables.
Rich editor features such as mentions, callouts, colors, underline, multiple
paragraphs inside a table cell and layout
attributes may not survive Markdown conversion. Unsupported nodes remain visible
as XML text and the reader reports representation losses. Code-block languages
are restored locally because the server converter discards them.

Replacement checks the affected document and converted input. Reported losses
require `--allow-loss`; `--force` does not approve them. A block edit leaves other
blocks intact. None of these commands prompts for input, and every command
supports `--json`. Run `i-plane page set --help` for flags and examples.

## Knowledge review marks

Writing a product node requires confirmation that the server preserves it.
Core 0.2.1 or newer reports retained node readers through
`GET /api/extensions/node-readers/`, independently of the wiki interface.
The CLI recognizes format version 1 and checks that the inventory matches the
current core, runtime release and reader fingerprint. Results share the existing
per-instance capability cache and `--refresh-pages`. Every custom-node write
rechecks the runtime identity, so a rollback cannot reuse a previous positive claim.

An absent endpoint means refusal with exit code **1**, before conversion, page
creation or document changes. `401`/`403` remain access errors; malformed inventory,
service errors and disagreement between runtimes do not mean an absent feature.
The rule applies to create, replace, insert and edits retaining existing review
nodes. `--allow-loss` and `--force` cannot override it. Ordinary Markdown and
explicit removal of the last review remain supported; existing review content
can still be read. A converter response that loses confirmed review nodes or
attributes is also rejected before a document write.

Saved detail responses from the matching extension include canonical JSON for
review restoration. If older HTML lost review attributes, `page show` can recover
them by the retained block ID. Missing or ambiguous IDs, invalid canonical fields,
stale review order and unsupported wrappers produce explicit losses. Canonical
JSON is used internally and omitted from the CLI output.

With the knowledge-review extension installed, a `knowledgeReview` block reads as
an ordinary fenced code block containing JSON:

````markdown
```knowledge-review
{
  "date": "2026-09-11",
  "source": "Release notes and a manual check"
}
```
````

`page read --block` returns this representation with no losses. Include it in a
Markdown file passed to `page set --file`, or use it for a block replacement, to
restore the same date and source as a semantic review node. `page outline` shows
`knowledgeReview` and a preview of both fields. Review dates use `YYYY-MM-DD` and
must be valid calendar dates; sources are nonempty strings. JSON escaping preserves
quotes and newlines. Unknown fields are rejected instead of silently discarded.

The fence language is reserved for review metadata. Raw HTML remains escaped.
Other unknown editor nodes still produce loss warnings and readable XML output.
