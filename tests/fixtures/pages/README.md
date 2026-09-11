# Page converter fixtures

Captured from the project's live converter using synthetic content. These files
contain no session cookies, account data or existing page content. The server
uses Hocuspocus 2.15.2 and Yjs 13.6.27; the client tests pin provider 4.7.0,
Yjs 13.6.32 and ws 8.21.3. Protocol compatibility depends on SyncStatus message 8
acknowledging an applied update; it does not acknowledge a database commit.

Each JSON fixture records source Markdown or HTML, the editor JSON and the raw
Yjs update encoded as base64. `schema.json` covers 17 structural node kinds and
six marks; unrecognized extensions still require explicit reporting.

Known converter losses: code-block languages are null, mentions and emoji nodes
can disappear, callouts collapse, and textStyle can lose color. The reader warns
about Markdown representation losses, and the writer checks converted content
before changing the live document. Language attributes are repaired locally.

Run `bun test tests/page-document.test.ts tests/page-live.test.ts
tests/page-commands.test.ts tests/page-api-key.test.ts` for the focused suite, and
`node scripts/page-mutations.mjs` to verify that five deliberate implementation
faults fail those tests. Mutations run in an isolated temporary copy.
