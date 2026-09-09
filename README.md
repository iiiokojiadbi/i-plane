# i-plane

A CLI for [Plane](https://plane.so) that prints lines, not JSON dumps.

Plane's own answer for seven work items is about **6,500 tokens** — twenty-nine
fields each. The same seven through `i-plane` are **145**. That is the whole point:
this tool is built for a coding agent reading the output, not for a browser
rendering it.

```
$ i-plane
WORKSPACE cloud  https://plane.example.com

PROJECTS
  CLOUD  cloud — 7 work items, 2 cycles, 3 modules

Next: i-plane list <PROJECT>   Map: i-plane guide

$ i-plane list CLOUD --state started
CLOUD-4  Create and assign work items [high] (In Progress)
CLOUD-5  Visualize your work (In Progress)
```

## Install

```bash
npm install -g i-plane
```

Node 20 or newer. No required dependencies.

## Configure

Three sources, highest wins. A wrapper that exports the environment once means
day-to-day calls carry no flags at all.

| | |
|---|---|
| flags | `--url`, `--token`, `--workspace` |
| environment | `PLANE_URL`, `PLANE_API_KEY`, `PLANE_WORKSPACE` |
| file | `KEY=VALUE` lines in `~/.config/plane/credentials` (mode 600) |

`PLANE_BASE_URL` and `PLANE_WORKSPACE_SLUG` are accepted too, so one environment
serves this and Plane's own MCP server. Point elsewhere with `--config` or
`PLANE_CONFIG`.

Not sure what is in effect:

```bash
$ i-plane config
url        https://plane.example.com  (file)
workspace  cloud  (env)
token      plane_…856f  (file)
file       /home/you/.config/plane/credentials
```

The token is an API key from **Workspace settings → API tokens**.

## Commands

Run `i-plane guide` for the map and the usual order of work. Short aliases exist
for what fingers type: `ls`, `new`, `set`, `rm`, `find`.

```
list [project]        work items, one line each      --state --priority --limit
show <ID>             one work item
search <text>         across the whole workspace
create <title>        --project --priority --state --description
update <ID>           --state --priority --name --description
done <ID>             move to the first completed state
comment <ID> <text>   add a comment
delete <ID> --yes     delete; refuses without --yes
projects, states, labels, members, whoami, config, guide
```

Work items are addressed the way people say them — `CLOUD-8`. Projects accept an
identifier (`CLOUD`), a name, or a unique name prefix.

Every command takes `--json` and then prints the model behind the output, for
when all the fields do matter.

## Design notes

**Filtering happens here, not there.** The list endpoint honours `fields` and
`expand` — which is where the real saving comes from, 11 KB down to 737 bytes on
the wire — but accepts `state_group`, `priority` and `order_by` with a 200 and
then ignores them. So the client narrows rows itself rather than trusting a
server-side filter that silently did nothing.

**Nothing ever prompts.** A CLI that waits for input hangs an agent forever.
A missing argument is an error that names what was expected.

**Exit codes are distinguishable.** `2` means the call was wrong, `1` means Plane
said no or could not be reached. Branch on that instead of parsing text.

**Proxies are optional and automatic.** Node's built-in fetch ignores
`HTTPS_PROXY`, which is fatal on a network where the proxy is also the only
resolver. If a proxy applies and `undici` is installed, it is used; otherwise the
command re-runs once with `NODE_USE_ENV_PROXY=1`. `NO_PROXY` is honoured. On a
plain network none of this runs and nothing is installed.

## License

MIT
