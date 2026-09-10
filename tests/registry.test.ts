import { describe, expect, test } from "bun:test";
import { parseCommandArgs } from "../src/args.ts";
import { PAGE_HANDLERS, isPageCommand } from "../src/page-dispatch.ts";
import { HANDLERS } from "../src/dispatch.ts";
import { ALL_COMMANDS, GLOBAL_OPTIONS } from "../src/registry.ts";
import { issueId, projectId, runFixture } from "./fixture.ts";

const calls: Record<string, string[]> = {
  cycles: ["cycles", "TEST"],
  modules: ["modules", "TEST"],
  "cycle create": [
    "cycle",
    "create",
    "First",
    "--project",
    "TEST",
    "--start",
    "2026-09-01",
    "--end",
    "2026-10-14",
  ],
  "cycle update": [
    "cycle",
    "update",
    "First",
    "--project",
    "TEST",
    "--name",
    "Renamed",
    "--start",
    "2026-09-01",
    "--end",
    "2026-10-14",
  ],
  "cycle add": ["cycle", "add", "TEST-1", "--project", "TEST", "--cycle", "First"],
  "cycle issues": ["cycle", "issues", "First", "--project", "TEST"],
  "cycle transfer": ["cycle", "transfer", "First", "Second", "--project", "TEST"],
  "module create": ["module", "create", "First", "--project", "TEST"],
  "module add": ["module", "add", "TEST-1", "--project", "TEST", "--module", "First"],
  "module issues": ["module", "issues", "First", "--project", "TEST"],
  "intake list": ["intake", "list", "--project", "TEST"],
  "intake create": ["intake", "create", "Incoming", "--project", "TEST"],
  "intake show": ["intake", "show", "TEST-1", "--project", "TEST"],
  "intake update": ["intake", "update", "TEST-1", "--project", "TEST", "--name", "Changed"],
  "intake rm": ["intake", "rm", "TEST-1", "--project", "TEST", "--yes"],

  "project create": ["project", "create", "Example", "--identifier", "EXAMPLE"],
  "project update": ["project", "update", "TEST", "--name", "Renamed"],
  "project archive": ["project", "archive", "TEST"],
  "project rm": ["project", "rm", "TEST", "--yes"],
  "label create": ["label", "create", "task", "--project", "TEST"],
  "label rm": ["label", "rm", "task", "--project", "TEST", "--yes"],
  "state create": [
    "state",
    "create",
    "Review",
    "--project",
    "TEST",
    "--group",
    "started",
    "--color",
    "#336699",
  ],
  "state update": ["state", "update", "In Progress", "--project", "TEST", "--name", "Review"],
  "state rm": ["state", "rm", "In Progress", "--project", "TEST", "--yes"],
  comments: ["comments", "TEST-1"],
  summary: ["summary"],
  projects: ["projects"],
  list: ["list", "TEST"],
  show: ["show", "TEST-1"],
  search: ["search", "Initial"],
  create: ["create", "Created", "--project", "TEST"],
  update: ["update", "TEST-1", "--name", "Changed"],
  done: ["done", "TEST-1"],
  comment: ["comment", "TEST-1", "Comment"],
  delete: ["delete", "TEST-1", "--yes"],
  states: ["states", "TEST"],
  labels: ["labels", "TEST"],
  members: ["members"],
  whoami: ["whoami"],
};
const offline = new Set(["config", "guide"]);

describe("the registry is executable", () => {
  test("registry and handlers cover exactly the same commands", () => {
    expect([...Object.keys(HANDLERS), ...Object.keys(PAGE_HANDLERS), ...offline].sort()).toEqual(
      ALL_COMMANDS.map((command) => command.name).sort(),
    );
  });
  const values: Record<string, string> = {
    project: "TEST",
    cycle: "First",
    module: "First",
    end: "2026-10-14",
    owner: "Reader",
    status: "accepted",
    "snooze-until": "2026-10-01",
    "duplicate-of": "TEST-2",
    identifier: "OTHER",
    name: "Renamed",
    color: "#336699",
    group: "started",
    description: "**Text**",
    priority: "urgent",
    state: "Done",
    limit: "1",
    label: "task",
    labels: "task",
    parent: "TEST-2",
    assignee: "Reader",
    due: "2026-10-01",
    start: "2026-09-01",
  };
  for (const command of ALL_COMMANDS.filter((entry) => !offline.has(entry.name) && !isPageCommand(entry.name))) {
    for (const option of command.options ?? []) {
      test(`${command.name} consumes its declared ${option.flag}`, async () => {
        const name = option.flag.slice(2);
        if (option.value !== undefined) expect(values[name]).toBeDefined();
        const base = [...calls[command.name]!];
        if (
          name === "project" &&
          ["list", "states", "labels", "cycles", "modules"].includes(command.name)
        )
          base.splice(1, 1);
        if (name === "snooze-until") base.push("--status", "snoozed");
        if (name === "duplicate-of") base.push("--status", "duplicate");
        const value =
          name === "status" && command.name === "module create" ? "planned" : values[name]!;
        const { readFlags, requests } = await runFixture([
          ...base,
          option.flag,
          ...(option.value === undefined ? [] : [value]),
        ]);
        if (command.name === "done" && !["project", "json"].includes(name)) {
          const field =
            (
              {
                description: "description_html",
                due: "target_date",
                start: "start_date",
                assignee: "assignees",
                label: "labels",
              } as Record<string, string>
            )[name] ?? name;
          expect(requests.find((request) => request.method === "PATCH")?.body).toHaveProperty(
            field,
          );
        } else expect(readFlags.has(name)).toBe(true);
      });
    }
  }

  for (const command of ALL_COMMANDS) {
    for (const option of [...GLOBAL_OPTIONS, ...(command.options ?? [])]) {
      test(`${command.name} parses ${option.flag} according to its declared shape`, () => {
        const value = option.value === undefined ? [] : ["sentinel value"];
        const args = parseCommandArgs([...command.name.split(" "), option.flag, ...value]);
        expect(args.flags.get(option.flag.slice(2))).toBe(
          option.value === undefined ? true : "sentinel value",
        );
        expect(args.positionals).toEqual([]);
      });
    }
    if (!offline.has(command.name) && !isPageCommand(command.name)) {
      test(`${command.name} has an executable handler and produces JSON`, async () => {
        expect(calls[command.name]).toBeDefined();
        const result = await runFixture(calls[command.name]!);
        expect(result.model).toBeDefined();
        expect(result.requests.length).toBeGreaterThan(0);
      });
    }
  }

  for (const command of ["create", "update", "done"]) {
    const fields =
      command === "create"
        ? { priority: "urgent", description: "**Text**", state: "Done" }
        : {
            priority: "urgent",
            description: "**Text**",
            name: "Renamed",
            ...(command === "done" ? {} : { state: "Done" }),
          };
    Object.assign(fields, {
      label: "task",
      labels: "task",
      parent: "TEST-2",
      assignee: "Reader",
      due: "2026-10-01",
      start: "2026-09-01",
    });
    for (const [flag, value] of Object.entries(fields)) {
      test(`${command} --${flag} changes the write payload`, async () => {
        const { requests } = await runFixture([...calls[command]!, `--${flag}`, value]);
        const write = requests.find(
          (request) => request.method === (command === "create" ? "POST" : "PATCH"),
        );
        const field =
          (
            {
              description: "description_html",
              due: "target_date",
              start: "start_date",
              assignee: "assignees",
              label: "labels",
            } as Record<string, string>
          )[flag] ?? flag;
        const expected =
          flag === "description"
            ? "<p><strong>Text</strong></p>"
            : flag === "state"
              ? "done"
              : flag === "parent"
                ? "parent-id"
                : flag === "assignee"
                  ? ["member-id"]
                  : ["label", "labels"].includes(flag)
                    ? ["label-id"]
                    : value;
        expect(write?.body[field]).toEqual(expected);
      });
    }
  }
  for (const command of [
    "list",
    "states",
    "labels",
    "show",
    "update",
    "done",
    "comment",
    "delete",
  ]) {
    test(`${command} actually uses --project`, async () => {
      const argv = [...calls[command]!];
      argv[1] = ["list", "states", "labels"].includes(command) ? "--project" : issueId;
      if (argv[1] === "--project") argv.push("TEST");
      else argv.push("--project", "TEST");
      const { requests } = await runFixture(argv);
      expect(requests.some((request) => request.path.startsWith(`projects/${projectId}/`))).toBe(
        true,
      );
      expect(requests.some((request) => request.path === "issues/TEST-1/")).toBe(false);
    });
  }
  for (const [flag, value, sequence] of [
    ["state", "completed", 2],
    ["priority", "low", 2],
    ["limit", "1", 1],
  ] as const) {
    test(`list --${flag} changes the returned rows`, async () => {
      const { model } = await runFixture(["list", "TEST", `--${flag}`, value]);
      expect(model.rows).toHaveLength(1);
      expect(model.rows[0].ref).toBe(`TEST-${sequence}`);
      expect(model.total).toBe(flag === "limit" ? 2 : 1);
    });
  }
  test("delete --yes=false never sends a request", async () => {
    await expect(runFixture(["delete", "TEST-1", "--yes=false"])).rejects.toThrow("--yes");
  });
});

describe("project setup and issue relationships", () => {
  test("project creation validates the name before any request", async () => {
    const trace: string[] = [];
    await expect(
      runFixture(["project", "create", "bad-name", "--identifier", "TEST"], { trace }),
    ).rejects.toThrow("special characters");
    expect(trace).toEqual([]);
  });
  test("project identifiers normalize and creation sends the description", async () => {
    const { requests, model } = await runFixture([
      "project",
      "create",
      "Knowledge Base",
      "--identifier",
      "kb",
      "--description",
      "Notes",
    ]);
    expect(requests).toEqual([
      {
        path: "projects/",
        method: "POST",
        body: { name: "Knowledge Base", identifier: "KB", description: "Notes" },
      },
    ]);
    expect(model.identifier).toBe("KB");
  });
  for (const identifier of ["TOOLONGIDENTIFIER", "3TEST", "bad-id", ""]) {
    test(`invalid identifier ${JSON.stringify(identifier)} is rejected before a request`, async () => {
      const trace: string[] = [];
      await expect(
        runFixture(["project", "create", "Example", "--identifier", identifier], { trace }),
      ).rejects.toThrow();
      expect(trace).toEqual([]);
    });
  }
  test("label creation provides a color even when omitted", async () => {
    const { requests } = await runFixture(calls["label create"]!);
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({
      name: "task",
      color: "#808080",
    });
  });
  test("adding a label preserves existing IDs and deduplicates", async () => {
    const { requests } = await runFixture(["update", "TEST-1", "--label", "task,task"], {
      labels: ["original", "label-id"],
    });
    expect(requests.find((request) => request.method === "PATCH")?.body.labels).toEqual([
      "original",
      "label-id",
    ]);
  });
  test("replacing labels deliberately discards the old list", async () => {
    const { requests } = await runFixture(["update", "TEST-1", "--labels", "task"], {
      labels: ["original"],
    });
    expect(requests.find((request) => request.method === "PATCH")?.body.labels).toEqual([
      "label-id",
    ]);
  });
  test("labels none sends an empty array", async () => {
    const { requests } = await runFixture(["update", "TEST-1", "--labels", "none"], {
      labels: ["original"],
    });
    expect(requests.find((request) => request.method === "PATCH")?.body.labels).toEqual([]);
  });
  for (const flags of [
    ["--labels", "task", "--label", "task"],
    ["--label", "none"],
    ["--parent", "TEST-1"],
    ["--due", "2026-02-30"],
    ["--start", "yesterday"],
    ["--priority", "urgentt"],
    ["--assignee", "nobody"],
  ]) {
    test(`invalid fields do not write: ${flags.join(" ")}`, async () => {
      const trace: string[] = [];
      await expect(runFixture(["update", "TEST-1", ...flags], { trace })).rejects.toThrow();
      expect(trace.some((request) => /^(POST|PATCH|DELETE) /.test(request))).toBe(false);
    });
  }
  test("ambiguous labels do not write or choose the first match", async () => {
    const trace: string[] = [];
    await expect(
      runFixture(["update", "TEST-1", "--label", "ta"], {
        trace,
        labelRows: [
          { id: "one", name: "task" },
          { id: "two", name: "tag" },
        ],
      }),
    ).rejects.toThrow("Ambiguous label");
    expect(trace.some((request) => request.startsWith("PATCH"))).toBe(false);
  });
  test("fields can be cleared without confusing none with an ID", async () => {
    const { requests } = await runFixture([
      "update",
      "TEST-1",
      "--parent",
      "none",
      "--assignee",
      "none",
      "--due",
      "none",
      "--start",
      "none",
    ]);
    expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({
      parent: null,
      assignees: [],
      target_date: null,
      start_date: null,
    });
  });
  test("an email resolves to a member ID", async () => {
    const { requests } = await runFixture([
      "update",
      "TEST-1",
      "--assignee",
      "reader@example.test",
    ]);
    expect(requests.find((request) => request.method === "PATCH")?.body.assignees).toEqual([
      "member-id",
    ]);
  });
  test("a successful update does not depend on a subsequent GET", async () => {
    const { requests, model } = await runFixture(["update", "TEST-1", "--name", "Changed"], {
      failAfterWrite: true,
    });
    expect(model.name).toBe("Changed");
    expect(requests.at(-1)?.method).toBe("PATCH");
  });
  test("comments follow all pages, sort chronologically and convert HTML", async () => {
    const { model } = await runFixture(["comments", "TEST-1"]);
    expect(model.map((comment: { id: string }) => comment.id)).toEqual(["older", "newer"]);
    expect(model[0].body).toBe("**First**");
    const shown = await runFixture(["show", "TEST-1", "--comments"]);
    expect(shown.model.comments).toEqual(model);
    const without = await runFixture(["show", "TEST-1"]);
    expect(without.requests.some((request) => request.path.endsWith("/comments/"))).toBe(false);
  });
  for (const command of ["project rm", "label rm", "state rm"]) {
    test(`${command} --yes=false makes no request`, async () => {
      const trace: string[] = [];
      await expect(runFixture([...calls[command]!, "--yes=false"], { trace })).rejects.toThrow(
        "--yes",
      );
      expect(trace).toEqual([]);
    });
  }
  for (const [command, flags, body] of [
    [
      "project update",
      ["--identifier", "OTHER", "--description", "Notes"],
      { identifier: "OTHER", description: "Notes", name: "Renamed" },
    ],
    [
      "label create",
      ["--color", "#112233", "--description", "Notes"],
      { name: "task", color: "#112233", description: "Notes" },
    ],
    [
      "state create",
      ["--description", "Notes"],
      { name: "Review", color: "#336699", group: "started", description: "Notes" },
    ],
    [
      "state update",
      ["--color", "#112233", "--group", "completed", "--description", "Notes"],
      { name: "Review", color: "#112233", group: "completed", description: "Notes" },
    ],
  ] as const) {
    test(`${command} writes every supplied field`, async () => {
      const { requests } = await runFixture([...calls[command]!, ...flags]);
      expect(requests.find((request) => ["PATCH", "POST"].includes(request.method))?.body).toEqual(
        body,
      );
    });
  }
});
