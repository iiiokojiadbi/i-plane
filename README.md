# i-plane

**Plane project management from the command line.**

Find the next task, read the discussion, update the work and keep moving.
`i-plane` brings your [Plane](https://plane.so) workspace into the terminal,
with compact output for coding agents and scripts.

```console
$ i-plane list APP --state started
APP-9  Fix search indexing [urgent] (In Progress)
APP-8  Refresh the onboarding guide [high] (In Progress)
```

Readable references like `APP-8`, Markdown for work item descriptions and
comments, and `--json` whenever you need structured data. Nothing prompts for input.

## What you can do

- **Manage tasks:** search, create, update and complete work; set parents,
  assignees, labels and dates; read and write comments.
- **Set up projects:** create projects, configure workflow states and labels,
  enable planning features, and archive finished projects.
- **Plan delivery:** schedule work in cycles, carry unfinished tasks forward,
  and group related work in modules that can span multiple cycles.
- **Triage requests:** collect reports in intake, then accept, reject, snooze
  or mark them as duplicates before committing to the work.
- **Maintain project knowledge:** read pages, inspect live blocks and edit only
  the section you need, with fingerprints to detect concurrent changes.
- **Automate:** use concise lists, JSON output and distinct exit codes in
  agent workflows and shell scripts.

## Install and connect

Requires **Node 22.21+ on the 22.x line, or Node 24+**.

```bash
npm install -g i-plane
```

Create a [Plane API token](https://developers.plane.so/api-reference/introduction#authentication)
and save these settings in `~/.config/plane/credentials`:

```ini
PLANE_URL=https://plane.example.com
PLANE_API_KEY=your-api-token
PLANE_WORKSPACE=your-workspace-slug
```

Keep the file private with `chmod 600 ~/.config/plane/credentials`.
`i-plane config` shows the active settings with the token masked.
Flags override environment variables, which override the credentials file.

## Find your workflow

The CLI carries its own guide. Start here:

```bash
i-plane guide                 # Command map and suggested workflow
i-plane create --help         # Required flags and working examples
i-plane module --help         # Commands for a feature area
i-plane intake update --help  # Triage decisions and what to do next
```

Help includes usage notes, examples and **USUALLY NEXT** commands, so you can
follow a workflow without memorizing the API. Running `i-plane` with no arguments
also opens the guide.

A typical task session:

```bash
i-plane summary
i-plane list APP --state unstarted
i-plane show APP-8 --comments
i-plane update APP-8 --state started
i-plane done APP-8
```

Workspace search returns up to 10 matches by default. Use `i-plane search "text"
--limit 100` to raise the bound (maximum 1000); output reports when more matches
exist. JSON search results contain `rows`, `limit` and `hasMore`.

Replace `APP` and `APP-8` with your project and work item references. Add `--json`
to any command for its structured result. Exit code `2` means an invalid call;
`1` means an API or connection failure.

For supported fields, compatibility details and development checks, see the
[capability reference](docs/api-coverage.md).

Pages prefer the same API key when the for-plane extension is available. On stock
Plane, the CLI detects the missing endpoint and uses password sign-in. See
the [page workflow](docs/pages.md) for setup, block edits and delivery semantics.
`i-plane page --help` carries the same command examples into your terminal.

## License

MIT
