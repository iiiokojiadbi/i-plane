import { flagBool, parseCommandArgs } from "../src/args.ts";
import { PlaneClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { dispatchCommand } from "../src/dispatch.ts";

export const projectId = "11111111-1111-4111-8111-111111111111";
export const issueId = "22222222-2222-4222-8222-222222222222";
const project = { id: projectId, identifier: "TEST", name: "Test Project" };
const states = [
  { id: "started", name: "In Progress", group: "started" },
  { id: "done", name: "Done", group: "completed" },
];
const config: Config = {
  url: { value: "https://plane.test", origin: "flag" },
  token: { value: "test-token", origin: "flag" },
  workspace: { value: "test", origin: "flag" },
  configPath: "/dev/null",
};

export const runFixture = async (
  argv: string[],
  options: {
    labels?: string[];
    labelRows?: Array<{ id: string; name: string }>;
    failAfterWrite?: boolean;
    failProjectInit?: boolean;
    trace?: string[];
    planRows?: Array<{ id: string; name: string }>;
    cycleOwner?: string | null;
    timezone?: string;
    expiredIntake?: boolean;
  } = {},
) => {
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  let issue = {
    id: issueId,
    project: projectId,
    sequence_id: 1,
    name: "Initial",
    priority: "high",
    state: "started",
    assignees: [],
    labels: options.labels ?? [],
    description_html: "",
    parent: null,
    target_date: null,
  };
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const originalErrorWrite = process.stderr.write;
  let diagnostics = "";
  process.stderr.write = ((chunk: string) => {
    diagnostics += chunk;
    return true;
  }) as typeof process.stderr.write;
  const originalExclusion = process.env.NO_PROXY;
  process.env.NO_PROXY = "*";
  let stdout = "";
  process.stdout.write = ((chunk: string) => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v1/workspaces/test/", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, method, body });
    options.trace?.push(`${method} ${path}`);
    let answer: unknown;
    const labelRows = options.labelRows ?? [{ id: "label-id", name: "task", color: "#112233" }];
    if (method === "DELETE" || path.endsWith("/archive/"))
      return new Response(null, { status: 204 });
    if (path === "projects/")
      answer =
        method === "POST" ? { ...project, ...body } : [{ ...project, timezone: options.timezone }];
    else if (path === `projects/${projectId}/`) {
      if (options.failProjectInit && method === "PATCH")
        return Response.json({ error: "queue initialization failed" }, { status: 500 });
      answer = { ...project, timezone: options.timezone, ...body };
    } else if (/\/(cycles|modules)(-lite)?\/$/.test(path)) {
      const kind = path.includes("/cycles") ? "cycle" : "module";
      const plans = options.planRows ?? [
        { id: `${kind}-id`, name: "First", start_date: "2026-01-01", end_date: "2026-01-14" },
        { id: `${kind}-next`, name: "Second", start_date: "2026-09-01", end_date: "2026-09-14" },
      ];
      answer = method === "GET" ? plans : { id: `${kind}-id`, ...body };
    } else if (method === "GET" && /\/cycles\/[^/]+\/$/.test(path))
      answer = {
        id: "cycle-id",
        name: "First",
        owned_by: options.cycleOwner === undefined ? "original-owner" : options.cycleOwner,
      };
    else if (method === "PATCH" && path.includes("/cycles/"))
      answer = { id: "cycle-id", name: "First", ...body };
    else if (/\/(cycle|module)-issues\/$/.test(path)) {
      answer = method === "GET" ? [{ ...issue, state: states[0] }] : { issues: body.issues };
    } else if (path.endsWith("/transfer-issues/")) answer = { message: "Success" };
    else if (path.includes("/intake-issues/")) {
      if (method === "GET" && options.expiredIntake)
        return path.endsWith("/intake-issues/")
          ? Response.json([])
          : Response.json({ error: "hidden expired snooze" }, { status: 404 });
      const item = {
        id: "intake-id",
        issue: issueId,
        issue_detail: {
          ...issue,
          description_html: "<p><strong>Incoming</strong></p>",
          ...(body.issue ?? {}),
        },
        status: -2,
        snoozed_till: null,
        duplicate_to: null,
      };
      if (method === "POST") answer = item;
      else if (method === "PATCH")
        answer = { ...item, ...body, issue: issueId, issue_detail: item.issue_detail };
      else if (path.endsWith("/intake-issues/"))
        answer = {
          results: [
            item,
            {
              ...item,
              id: "rejected-id",
              issue: "other-issue",
              status: -1,
              issue_detail: { ...issue, id: "other-issue", sequence_id: 2 },
            },
          ],
          next_page_results: false,
        };
      else answer = item;
    } else if (path === "issues/OTHER-1/") answer = { ...issue, project: "other-project" };
    else if (path.endsWith("/states/") || path.includes("/states/"))
      answer = method === "GET" ? states : { ...states[0], ...body };
    else if (path.endsWith("/labels/"))
      answer = method === "GET" ? labelRows : { id: "label-id", ...body };
    else if (path === "members-lite/")
      answer = [{ id: "member-id", display_name: "Reader", email: "reader@example.test" }];
    else if (path === "/api/v1/users/me/") answer = { id: "member-id", display_name: "Reader" };
    else if (path === "issues/search/")
      answer = { issues: [{ ...issue, project__identifier: "TEST" }] };
    else if (path.endsWith("/summary/"))
      answer = { counts: { issues: 2, cycles: 0, modules: 0, members: 1, labels: 1, states: 2 } };
    else if (path.endsWith("/comments/")) {
      if (method === "POST") answer = { id: "comment-id" };
      else if (url.searchParams.has("cursor"))
        answer = [
          {
            id: "older",
            actor: "member-id",
            created_at: "2026-01-01T00:00:00Z",
            comment_html: "<p><strong>First</strong></p>",
          },
        ];
      else
        answer = {
          results: [
            {
              id: "newer",
              actor: "member-id",
              created_at: "2026-01-02T00:00:00Z",
              comment_html: "<p>Second</p>",
            },
          ],
          next_page_results: true,
          next_cursor: "page2",
        };
    } else if (method === "PATCH" || method === "POST") {
      issue = { ...issue, ...body };
      answer = issue;
    } else if (path === `projects/${projectId}/issues/`)
      answer = [
        { ...issue, state: states[0] },
        { ...issue, id: "another", sequence_id: 2, priority: "low", state: states[1] },
      ];
    else if (path === "issues/TEST-2/") answer = { ...issue, id: "parent-id", sequence_id: 2 };
    else if (path === "issues/TEST-1/" || path === `projects/${projectId}/issues/${issueId}/`) {
      if (options.expiredIntake)
        return Response.json({ error: "triage work is hidden" }, { status: 404 });
      if (options.failAfterWrite && requests.some((request) => request.method === "PATCH"))
        throw new Error("read failed after write");
      answer = issue;
    } else throw new Error(`Unexpected fixture request: ${method} ${path}`);
    return Response.json(answer);
  }) as typeof fetch;
  try {
    const parsed = parseCommandArgs([...argv, "--json"]);
    const readFlags = new Set<string>();
    class ObservedFlags extends Map<string, string | true> {
      override get(name: string) {
        readFlags.add(name);
        return super.get(name);
      }
    }
    const args = { ...parsed, flags: new ObservedFlags(parsed.flags) };
    await dispatchCommand(
      args.path.join(" "),
      new PlaneClient(config),
      args,
      config,
      flagBool(args, "json"),
    );
    return { requests, model: JSON.parse(stdout), readFlags, diagnostics };
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
    if (originalExclusion === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = originalExclusion;
  }
};
