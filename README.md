# i-plane

A command-line client for [Plane](https://plane.so) that prints lines instead of
JSON dumps.

Ask Plane's API for seven work items and it answers with twenty-nine fields
each — about 6,500 tokens. The same seven through `i-plane` are 145. If you are
piping work items into a coding agent, that difference is the entire point.

```
$ i-plane list CLOUD --state started
CLOUD-4  Create and assign work items [high] (In Progress)
CLOUD-5  Visualize your work (In Progress)
```

## Install

```bash
npm install -g i-plane
```

Node 20 or newer.

## Set it up

You need three things: the address of your Plane, an API key, and a workspace.
The key comes from **Workspace settings → API tokens**.

Supply them however suits you — flags win over environment, environment wins over
the file:

```bash
# once, in a file
mkdir -p ~/.config/plane && chmod 700 ~/.config/plane
cat > ~/.config/plane/credentials <<'EOF'
PLANE_URL=https://plane.example.com
PLANE_API_KEY=plane_api_…
PLANE_WORKSPACE=my-workspace
EOF
chmod 600 ~/.config/plane/credentials

# or per call
i-plane list CLOUD --url https://plane.example.com --token … --workspace my-workspace
```

Not sure what is in effect:

```
$ i-plane config
url        https://plane.example.com  (file)
workspace  my-workspace  (env)
token      plane_…856f  (file)
file       /home/you/.config/plane/credentials
```

## Use it

Run `i-plane` with no arguments and it shows the command map, the usual order of
work, and how it behaves. `i-plane <command> --help` gives one command's flags
and real examples.

```
summary               projects and how much is in each
list [project]        work items, one line each    --state --priority --limit
show <ID>             one work item, description included
search <text>         across the whole workspace
create <title>        --project --priority --state --description
update <ID>           --state --priority --name --description
done <ID>             move to the first completed state
comment <ID> <text>   add a comment
delete <ID> --yes     delete; refuses without --yes
projects  states  labels  members  whoami  config  guide
```

Short forms for what fingers type: `ls`, `new`, `set`, `rm`, `find`.

Work items go by the name people say — `CLOUD-8`. Projects take an identifier
(`CLOUD`), a full name, or a unique prefix of one.

Every command accepts `--json` and then prints the whole model, for when you need
ids and timestamps rather than a readable line.

## Descriptions are Markdown

Write them as Markdown; read them back as Markdown. Plane stores HTML, and the
translation happens here.

````bash
i-plane create --project CLOUD "Fix the resolver" --description '## Steps

```bash
dig +short example.com @127.0.0.1
```

| Node | Role | Status |
| ---- | ---- | ------ |
| pi5  | DNS  | broken |

1. check the cache
2. check the routes'
````

Code fences keep their language, tables stay tables, ordered lists stay numbered.
Raw HTML in a description is escaped rather than passed through, so nothing you
write can execute in someone else's browser.

## Good to know

**A list is complete unless it says so.** `list` returns every work item in the
project. `--limit` exists, but when it cuts the list the last line tells you how
many rows it hid.

**Exit codes mean something.** `2` — the command was wrong. `1` — Plane refused or
could not be reached. Useful in scripts.

**Proxies work without configuration.** If `HTTPS_PROXY` applies to your Plane
address, it is used; `NO_PROXY` is honoured the way curl honours it, including
CIDR ranges. On a network without a proxy none of this runs.

## Contributing

`AGENTS.md` has the working rules: the invariants, the checks to run, and the
bugs that already shipped once.

## License

MIT
