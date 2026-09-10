import { describe, expect, test } from "bun:test";
import { formatIntake, formatIntakeList } from "../src/commands/intake.ts";
import { formatPlan } from "../src/commands/planning.ts";
import { issueId, projectId, runFixture } from "./fixture.ts";

describe("planning request contracts", () => {
  test("cycle dates and owner are resolved before creation", async () => {
    const { requests, model } = await runFixture([
      "cycle",
      "create",
      "Sprint",
      "--project",
      "TEST",
      "--start",
      "2026-10-01",
      "--end",
      "2026-10-14",
      "--owner",
      "Reader",
      "--description",
      "Planning",
    ]);
    expect(requests.at(-1)).toEqual({
      path: `projects/${projectId}/cycles/`,
      method: "POST",
      body: {
        name: "Sprint",
        start_date: "2026-10-01",
        end_date: "2026-10-14",
        owned_by: "member-id",
        project_id: projectId,
        description: "Planning",
      },
    });
    expect(model.id).toBe("cycle-id");
  });
  test("a draft cycle uses the current user when no owner is supplied", async () => {
    const { requests } = await runFixture(["cycle", "create", "Draft", "--project", "TEST"]);
    expect(requests.some((request) => request.path === "/api/v1/users/me/")).toBe(true);
    expect(requests.at(-1)?.body).toEqual({
      name: "Draft",
      owned_by: "member-id",
      project_id: projectId,
    });
  });
  test("module creation uses module dates and status", async () => {
    const { requests } = await runFixture([
      "module",
      "create",
      "Documentation",
      "--project",
      "TEST",
      "--start",
      "2026-10-01",
      "--due",
      "2026-11-01",
      "--status",
      "planned",
      "--description",
      "Notes",
    ]);
    expect(requests.at(-1)).toEqual({
      path: `projects/${projectId}/modules/`,
      method: "POST",
      body: {
        name: "Documentation",
        start_date: "2026-10-01",
        target_date: "2026-11-01",
        status: "planned",
        description: "Notes",
      },
    });
  });
  test("cycle update sends a PATCH with all selected fields", async () => {
    const { requests } = await runFixture([
      "cycle",
      "update",
      "First",
      "--project",
      "TEST",
      "--name",
      "Renamed",
      "--description",
      "Notes",
      "--start",
      "none",
      "--end",
      "none",
      "--owner",
      "Reader",
    ]);
    expect(requests.at(-1)).toEqual({
      path: `projects/${projectId}/cycles/cycle-id/`,
      method: "PATCH",
      body: {
        name: "Renamed",
        description: "Notes",
        start_date: null,
        end_date: null,
        owned_by: "member-id",
      },
    });
  });
  for (const kind of ["cycle", "module"]) {
    test(`${kind} add resolves readable references and deduplicates work items`, async () => {
      const { requests } = await runFixture([
        kind,
        "add",
        "TEST-1",
        "TEST-2",
        "TEST-1",
        "--project",
        "TEST",
        `--${kind}`,
        "First",
      ]);
      expect(requests.at(-1)).toEqual({
        path: `projects/${projectId}/${kind}s/${kind}-id/${kind}-issues/`,
        method: "POST",
        body: { issues: [issueId, "parent-id"] },
      });
    });
    test(`${kind} add rejects another project's work before sending any write`, async () => {
      const trace: string[] = [];
      await expect(
        runFixture([kind, "add", "TEST-1", "OTHER-1", "--project", "TEST", `--${kind}`, "First"], {
          trace,
        }),
      ).rejects.toThrow("does not belong");
      expect(trace.some((request) => request.startsWith("POST"))).toBe(false);
    });
    test(`${kind} name ambiguity never chooses the first match`, async () => {
      await expect(
        runFixture([kind, "issues", "First", "--project", "TEST"], {
          planRows: [
            { id: "one", name: "First sprint" },
            { id: "two", name: "First phase" },
          ],
        }),
      ).rejects.toThrow("Ambiguous");
    });
    test(`${kind} issues prints work item references rather than relationship IDs`, async () => {
      const { model } = await runFixture([kind, "issues", "First", "--project", "TEST"]);
      expect(model).toMatchObject({
        total: 1,
        rows: [{ id: issueId, ref: "TEST-1", name: "Initial", state: "In Progress" }],
      });
    });
  }
  test("transfer posts the target ID to the source endpoint", async () => {
    const { requests, model } = await runFixture([
      "cycle",
      "transfer",
      "First",
      "Second",
      "--project",
      "TEST",
    ]);
    expect(requests.at(-1)).toEqual({
      path: `projects/${projectId}/cycles/cycle-id/transfer-issues/`,
      method: "POST",
      body: { new_cycle_id: "cycle-next" },
    });
    expect(model.from.id).toBe("cycle-id");
    expect(model.to.id).toBe("cycle-next");
  });
  for (const argv of [
    ["cycle", "create", "Sprint", "--start", "2026-10-01"],
    ["cycle", "create", "Sprint", "--start", "2026-10-14", "--end", "2026-10-01"],
    ["cycle", "create", "Sprint", "--start", "2026-02-30", "--end", "2026-03-02"],
    ["module", "create", "Module", "--status", "accepted"],
    ["cycle", "add", "--cycle", "First"],
    ["module", "add", "--module", "First"],
    ["cycle", "transfer", "First", "First"],
    ["cycle", "update", "First"],
  ]) {
    test(`invalid planning call never writes: ${argv.join(" ")}`, async () => {
      const trace: string[] = [];
      await expect(runFixture([...argv, "--project", "TEST"], { trace })).rejects.toThrow();
      expect(trace.some((request) => /^(POST|PATCH|DELETE)/.test(request))).toBe(false);
    });
  }
});

describe("intake lifecycle contracts", () => {
  test("creation nests Markdown-converted issue data", async () => {
    const { requests, model } = await runFixture([
      "intake",
      "create",
      "Incoming",
      "--project",
      "TEST",
      "--description",
      "**Details**",
      "--priority",
      "high",
    ]);
    expect(requests.at(-1)).toEqual({
      path: `projects/${projectId}/intake-issues/`,
      method: "POST",
      body: {
        issue: {
          name: "Incoming",
          description_html: "<p><strong>Details</strong></p>",
          priority: "high",
        },
      },
    });
    expect(model.ref).toBe("TEST-1");
    expect(model.issueId).toBe(issueId);
  });
  test("status filtering happens locally and keeps the requested status", async () => {
    const { model } = await runFixture(["intake", "list", "TEST", "--status", "rejected"]);
    expect(model).toHaveLength(1);
    expect(model[0].statusCode).toBe(-1);
  });
  test("editing uses the work item ID in the path, not the intake entry ID", async () => {
    const { requests, model } = await runFixture([
      "intake",
      "update",
      "TEST-1",
      "--project",
      "TEST",
      "--name",
      "Renamed",
      "--description",
      "**Text**",
      "--priority",
      "urgent",
      "--status",
      "accepted",
    ]);
    expect(requests.at(-1)).toEqual({
      path: `projects/${projectId}/intake-issues/${issueId}/`,
      method: "PATCH",
      body: {
        issue: {
          name: "Renamed",
          description_html: "<p><strong>Text</strong></p>",
          priority: "urgent",
        },
        status: 1,
        snoozed_till: null,
        duplicate_to: null,
      },
    });
    expect(model).toMatchObject({
      name: "Renamed",
      description: "**Text**",
      priority: "urgent",
      status: "accepted",
    });
  });
  test("snoozing sends a timestamp and pending clears stale metadata", async () => {
    const snoozed = await runFixture([
      "intake",
      "update",
      "TEST-1",
      "--project",
      "TEST",
      "--status",
      "snoozed",
      "--snooze-until",
      "2026-10-01",
    ]);
    expect(snoozed.requests.at(-1)?.body).toEqual({
      status: 0,
      snoozed_till: "2026-10-01T00:00:00Z",
      duplicate_to: null,
    });
    const pending = await runFixture([
      "intake",
      "update",
      "TEST-1",
      "--project",
      "TEST",
      "--status",
      "pending",
    ]);
    expect(pending.requests.at(-1)?.body).toEqual({
      status: -2,
      snoozed_till: null,
      duplicate_to: null,
    });
  });
  test("duplicate targets resolve readable IDs", async () => {
    const { requests } = await runFixture([
      "intake",
      "update",
      "TEST-1",
      "--project",
      "TEST",
      "--status",
      "duplicate",
      "--duplicate-of",
      "TEST-2",
    ]);
    expect(requests.at(-1)?.body).toEqual({
      status: 2,
      snoozed_till: null,
      duplicate_to: "parent-id",
    });
  });
  test("show accepts an underlying UUID directly and formats Markdown", async () => {
    const { model, requests } = await runFixture(["intake", "show", issueId, "--project", "TEST"]);
    expect(requests.at(-1)?.path).toBe(`projects/${projectId}/intake-issues/${issueId}/`);
    expect(formatIntake(model)).toContain("**Incoming**");
    expect(formatIntakeList([model])).toContain("TEST-1");
  });
  test("delete uses the intake route and requires true confirmation", async () => {
    const { requests } = await runFixture(["intake", "rm", "TEST-1", "--project", "TEST", "--yes"]);
    expect(requests.at(-1)).toEqual({
      path: `projects/${projectId}/intake-issues/${issueId}/`,
      method: "DELETE",
      body: {},
    });
    const trace: string[] = [];
    await expect(
      runFixture(["intake", "rm", "TEST-1", "--project", "TEST", "--yes=false"], { trace }),
    ).rejects.toThrow("--yes");
    expect(trace).toEqual([]);
  });
  for (const flags of [
    [],
    ["--status", "started"],
    ["--status", "snoozed"],
    ["--status", "duplicate"],
    ["--snooze-until", "2026-10-01"],
    ["--status", "snoozed", "--snooze-until", "none"],
    ["--status", "duplicate", "--duplicate-of", "TEST-1"],
    ["--status", "duplicate", "--duplicate-of", "OTHER-1"],
  ]) {
    test(`invalid intake update never writes: ${flags.join(" ")}`, async () => {
      const trace: string[] = [];
      await expect(
        runFixture(["intake", "update", "TEST-1", "--project", "TEST", ...flags], { trace }),
      ).rejects.toThrow();
      expect(trace.some((request) => request.startsWith("PATCH"))).toBe(false);
    });
  }
  test("project feature switches send booleans, including explicit false", async () => {
    const { requests } = await runFixture([
      "project",
      "update",
      "TEST",
      "--intake",
      "--cycles=false",
      "--modules",
    ]);
    expect(requests.at(-1)?.body).toEqual({
      intake_view: true,
      cycle_view: false,
      module_view: true,
    });
  });
  test("plan formatting preserves dates and status", () => {
    expect(
      formatPlan({
        id: "module-id",
        name: "Docs",
        status: "planned",
        start_date: "2026-10-01",
        target_date: "2026-10-14",
      }),
    ).toContain("2026-10-01 / 2026-10-14 (planned)");
  });
});

describe("intake initialization on project creation", () => {
  test("enabling intake creates the project and then initializes its queue through PATCH", async () => {
    const { requests, model } = await runFixture([
      "project",
      "create",
      "Incoming",
      "--identifier",
      "TEST",
      "--intake",
    ]);
    expect(requests).toEqual([
      { path: "projects/", method: "POST", body: { name: "Incoming", identifier: "TEST" } },
      { path: `projects/${projectId}/`, method: "PATCH", body: { intake_view: true } },
    ]);
    expect(model.intake_view).toBe(true);
  });
  test("a failed queue initialization preserves creation success and reports how to retry", async () => {
    const { model, requests, diagnostics } = await runFixture(
      ["project", "create", "Incoming", "--identifier", "TEST", "--intake"],
      { failProjectInit: true },
    );
    expect(model.id).toBe(projectId);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(diagnostics).toContain("was created, but intake setup failed");
    expect(diagnostics).toContain(`project update ${projectId} --intake`);
  });
  test("intake=false does not initialize a queue", async () => {
    const { requests } = await runFixture([
      "project",
      "create",
      "Incoming",
      "--identifier",
      "TEST",
      "--intake=false",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.intake_view).toBe(false);
  });
});

describe("review regressions", () => {
  test("renaming preserves the existing cycle owner instead of defaulting to the token user", async () => {
    const { requests } = await runFixture(
      ["cycle", "update", "First", "--project", "TEST", "--name", "Renamed"],
      { cycleOwner: "another-member" },
    );
    expect(requests.at(-1)?.body).toEqual({ name: "Renamed", owned_by: "another-member" });
    expect(
      requests.some(
        (request) =>
          request.method === "GET" && request.path === `projects/${projectId}/cycles/cycle-id/`,
      ),
    ).toBe(true);
  });
  test("an explicit owner does not need a preservation lookup", async () => {
    const { requests } = await runFixture([
      "cycle",
      "update",
      "First",
      "--project",
      "TEST",
      "--owner",
      "Reader",
    ]);
    expect(requests.at(-1)?.body).toEqual({ owned_by: "member-id" });
    expect(
      requests.some(
        (request) =>
          request.method === "GET" && request.path === `projects/${projectId}/cycles/cycle-id/`,
      ),
    ).toBe(false);
  });
  test("a missing current owner refuses to guess or overwrite it", async () => {
    const trace: string[] = [];
    await expect(
      runFixture(["cycle", "update", "First", "--project", "TEST", "--name", "Renamed"], {
        cycleOwner: null,
        trace,
      }),
    ).rejects.toThrow("Cannot preserve the cycle owner");
    expect(trace.some((request) => request.startsWith("PATCH"))).toBe(false);
  });
  for (const action of ["create", "update"]) {
    for (const flag of ["--start", "--end"]) {
      test(`${action} ${flag} none cannot clear half a date range`, async () => {
        const trace: string[] = [];
        await expect(
          runFixture(["cycle", action, "First", "--project", "TEST", flag, "none"], { trace }),
        ).rejects.toThrow("both --start and --end");
        expect(trace).toEqual([]);
      });
    }
  }
  test("clearing both dates preserves the owner", async () => {
    const { requests } = await runFixture([
      "cycle",
      "update",
      "First",
      "--project",
      "TEST",
      "--start",
      "none",
      "--end",
      "none",
    ]);
    expect(requests.at(-1)?.body).toEqual({
      start_date: null,
      end_date: null,
      owned_by: "original-owner",
    });
  });
  for (const [timezone, start_date, end_date] of [
    ["Europe/Moscow", "2026-09-30T21:00:01Z", "2026-10-14T20:59:00Z"],
    ["America/Los_Angeles", "2026-10-01T07:00:01Z", "2026-10-15T06:59:00Z"],
  ]) {
    test(`cycle dates use the project calendar in ${timezone}`, () => {
      expect(
        formatPlan({ id: "cycle-id", name: "Sprint", timezone, start_date, end_date }),
      ).toContain("2026-10-01 / 2026-10-14");
    });
  }
  test("calendar formatting handles daylight saving boundaries", () => {
    expect(
      formatPlan({
        id: "cycle-id",
        name: "Sprint",
        timezone: "America/New_York",
        start_date: "2026-11-01T04:00:01Z",
        end_date: "2026-11-02T04:59:00Z",
      }),
    ).toContain("2026-11-01 / 2026-11-01");
  });
  test("an unknown timezone preserves the timestamp rather than guessing a calendar day", () => {
    expect(
      formatPlan({ id: "cycle-id", name: "Sprint", start_date: "2026-09-30T21:00:01Z" }),
    ).toContain("2026-09-30T21:00:01Z");
  });
  test("cycle listing and mutations attach the project timezone", async () => {
    const listed = await runFixture(["cycles", "TEST"], { timezone: "Europe/Moscow" });
    expect(
      listed.model.every((plan: { timezone: string }) => plan.timezone === "Europe/Moscow"),
    ).toBe(true);
    const created = await runFixture(["cycle", "create", "Draft", "--project", "TEST"], {
      timezone: "Europe/Moscow",
    });
    expect(created.model.timezone).toBe("Europe/Moscow");
    const updated = await runFixture(
      ["cycle", "update", "First", "--project", "TEST", "--name", "Renamed"],
      { timezone: "Europe/Moscow" },
    );
    expect(updated.model.timezone).toBe("Europe/Moscow");
  });
  for (const action of ["update", "rm"]) {
    test(`${action} an expired intake UUID without a filtered GET`, async () => {
      const flags = action === "update" ? ["--status", "accepted"] : ["--yes"];
      const { requests } = await runFixture(
        ["intake", action, issueId, "--project", "TEST", ...flags],
        { expiredIntake: true },
      );
      expect(requests.at(-1)?.method).toBe(action === "update" ? "PATCH" : "DELETE");
      expect(requests.at(-1)?.path).toBe(`projects/${projectId}/intake-issues/${issueId}/`);
      expect(
        requests.some(
          (request) => request.method === "GET" && request.path.includes("/intake-issues/"),
        ),
      ).toBe(false);
    });
  }
  test("visible triage references continue to resolve through the intake queue", async () => {
    const { requests } = await runFixture([
      "intake",
      "update",
      "TEST-1",
      "--project",
      "TEST",
      "--status",
      "accepted",
    ]);
    expect(requests.some((request) => request.path === "issues/TEST-1/")).toBe(false);
    expect(requests.at(-1)?.path).toBe(`projects/${projectId}/intake-issues/${issueId}/`);
  });
  test("an unresolvable expired intake reference points to the usable UUID path", async () => {
    await expect(
      runFixture(["intake", "update", "TEST-1", "--project", "TEST", "--status", "accepted"], {
        expiredIntake: true,
      }),
    ).rejects.toThrow("underlying work item UUID");
  });
});
