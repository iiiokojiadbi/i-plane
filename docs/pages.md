# Project pages

Read project knowledge as Markdown, then change a section without rewriting the
rest of the document. Page metadata uses the API-key pages endpoint; content
changes use the collaborative live editor.

## Connect

Page commands require a Plane deployment with the for-plane API-key pages
extension enabled. Stock Plane does not expose this access path. Configure the
same three settings used for work items:

```ini
PLANE_URL=https://plane.example.com
PLANE_WORKSPACE=workspace
PLANE_API_KEY=your-api-key
```

`i-plane config` reports each setting's source and masks the key. HTTP and live
connections use that key; the server derives the user and checks current page
permissions. Read commands request read-only live access. HTTP and WebSocket
connections honor `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`.

Version 2 removes password sign-in, cookie caching and automatic reauthentication.
Legacy login, password and cache settings are ignored. Old cache files are never
opened or migrated. There is no fallback on installations without the extension.
A rejected or uncertain write is never replayed automatically.

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

## Knowledge review marks

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
