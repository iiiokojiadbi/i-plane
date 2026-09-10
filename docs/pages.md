# Project pages

Read project knowledge as Markdown, then change a section without rewriting the
rest of the document. Pages use Plane's internal session API and live editor;
they are available on instances exposing project pages and the live service.

## Connect

Add these to your private credentials file alongside `PLANE_URL` and
`PLANE_WORKSPACE`:

```ini
PLANE_LOGIN=you@example.com
PLANE_PASSWORD=your-password
```

An API token is optional for page commands and still required for work items.
`i-plane config` reports whether credentials are configured and where they came
from, without printing the login password or cookies. Sessions persist under
`$XDG_CACHE_HOME/i-plane/sessions` or `~/.cache/i-plane/sessions`; the directory
has mode 700 and files have mode 600. A restricted environment can select a
private writable directory with `PLANE_SESSION_CACHE` or `--session-cache`.
An expired session receives one refresh. HTTP and WebSocket connections honor
`HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`.

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
Nested pages and `--parent` are unsupported by the project-page API.

## Delivery and formatting

Successful editing means **the live server acknowledged delivery**. It does not
confirm a database commit. `page show` reads saved HTML and can immediately show
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
