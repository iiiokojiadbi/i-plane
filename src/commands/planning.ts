import { flagValue, type ParsedArgs, UsageError } from "../args.ts";
import { type PlaneClient, PlaneError } from "../client.ts";
import { oneLine, printColumns } from "../output.ts";
import { resolveIssue, resolveNamed, resolveProject } from "../resolve.ts";
import type { Project } from "../types.ts";
import { choice, dateValue, requireChanges, required, requiredFlag } from "../validation.ts";
import { resolveMember } from "./issue-fields.ts";
import { type ExpandedIssue, issueToRow, type Listing } from "./issues.ts";

export type PlanningKind = "cycle" | "module";
export interface Plan {
  readonly id: string;
  readonly name: string;
  readonly start_date?: string | null;
  readonly end_date?: string | null;
  readonly target_date?: string | null;
  readonly status?: string;
  readonly owned_by?: string | null;
  readonly timezone?: string;
}

const projectFor = (client: PlaneClient, args: ParsedArgs, positional = false): Promise<Project> =>
  resolveProject(
    client,
    required(
      (positional ? args.positionals[0] : undefined) ?? flagValue(args, "project"),
      "--project <ref>",
    ),
    "id,name,identifier,timezone",
  );

export const listPlans = async (
  client: PlaneClient,
  args: ParsedArgs,
  kind: PlanningKind,
): Promise<ReadonlyArray<Plan>> => {
  const project = await projectFor(client, args, true);
  const plans = await client.listAll<Plan>(`projects/${project.id}/${kind}s/`, {
    query: {
      fields:
        kind === "cycle" ? "id,name,start_date,end_date" : "id,name,start_date,target_date,status",
      per_page: 100,
    },
  });
  return plans.map((plan) => withProjectTimezone(plan, project, kind));
};

const withProjectTimezone = (plan: Plan, project: Project, kind: PlanningKind): Plan =>
  kind === "cycle" && project.timezone !== undefined
    ? { ...plan, timezone: project.timezone }
    : plan;

const plansForResolution = (
  client: PlaneClient,
  projectId: string,
  kind: PlanningKind,
): Promise<ReadonlyArray<Plan>> =>
  client.listAll<Plan>(`projects/${projectId}/${kind}s-lite/`, { query: { per_page: 100 } });

const planFields = (args: ParsedArgs, kind: PlanningKind): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  const name = flagValue(args, "name");
  if (name !== undefined) body.name = required(name, `a ${kind} name`);
  const description = flagValue(args, "description");
  if (description !== undefined) body.description = description;
  const start = flagValue(args, "start");
  const finishFlag = kind === "cycle" ? "end" : "due";
  const finish = flagValue(args, finishFlag);
  const startDate = start === undefined ? null : dateValue(start, "start");
  const finishDate = finish === undefined ? null : dateValue(finish, finishFlag);
  if (
    kind === "cycle" &&
    ((start === undefined) !== (finish === undefined) ||
      (startDate === null) !== (finishDate === null))
  )
    throw new UsageError("A cycle needs both --start and --end, or neither for a draft.");
  if (startDate !== null && finishDate !== null && startDate > finishDate)
    throw new UsageError("The start date must not be after the end date.");
  if (start !== undefined) body.start_date = startDate;
  if (finish !== undefined) body[kind === "cycle" ? "end_date" : "target_date"] = finishDate;
  if (kind === "module") {
    const status = flagValue(args, "status");
    if (status !== undefined)
      body.status = choice(
        status,
        ["backlog", "planned", "in-progress", "paused", "completed", "cancelled"],
        "status",
      );
  }
  return body;
};

export const createPlan = async (
  client: PlaneClient,
  args: ParsedArgs,
  kind: PlanningKind,
): Promise<Plan> => {
  const body = {
    ...planFields(args, kind),
    name: required(args.positionals.join(" "), `a ${kind} name`),
  } as Record<string, unknown>;
  const project = await projectFor(client, args);
  if (kind === "cycle") {
    const owner = flagValue(args, "owner");
    body.owned_by =
      owner === undefined
        ? (await client.request<{ id: string }>("/api/v1/users/me/")).id
        : await resolveMember(client, owner);
    body.project_id = project.id;
  }
  const created = await client.request<Plan>(`projects/${project.id}/${kind}s/`, {
    method: "POST",
    body,
  });
  return withProjectTimezone(created, project, kind);
};

export const updateCycle = async (client: PlaneClient, args: ParsedArgs): Promise<Plan> => {
  const ref = required(args.positionals[0], "a cycle name or UUID");
  const body = planFields(args, "cycle");
  const owner = flagValue(args, "owner");
  if (owner === undefined) requireChanges(body);
  const project = await projectFor(client, args);
  const cycle = resolveNamed(await plansForResolution(client, project.id, "cycle"), ref, "cycle");
  if (owner !== undefined) body.owned_by = await resolveMember(client, owner);
  else {
    const current = await client.request<Plan>(`projects/${project.id}/cycles/${cycle.id}/`, {
      query: { fields: "id,name,owned_by" },
    });
    if (!current.owned_by)
      throw new PlaneError(
        "Cannot preserve the cycle owner: the server did not return owned_by. Pass --owner explicitly.",
      );
    // Some servers default a missing PATCH owner to the requesting user.
    body.owned_by = current.owned_by;
  }
  const updated = await client.request<Plan | undefined>(
    `projects/${project.id}/cycles/${cycle.id}/`,
    { method: "PATCH", body },
  );
  return withProjectTimezone(updated ?? { ...cycle, ...body }, project, "cycle");
};

export interface PlanChange {
  readonly project: string;
  readonly id: string;
  readonly name: string;
  readonly issues: ReadonlyArray<string>;
}

export const addPlanIssues = async (
  client: PlaneClient,
  args: ParsedArgs,
  kind: PlanningKind,
): Promise<PlanChange> => {
  if (args.positionals.length === 0)
    throw new UsageError("Expected one or more work item references.");
  const planRef = requiredFlag(args, kind);
  const project = await projectFor(client, args);
  const plan = resolveNamed(await plansForResolution(client, project.id, kind), planRef, kind);
  const ids = new Set<string>();
  for (const ref of args.positionals) {
    const resolved = await resolveIssue(client, ref, project.id);
    if (resolved.projectId !== project.id)
      throw new UsageError(`${ref} does not belong to project ${project.identifier}.`);
    ids.add(resolved.issue.id);
  }
  await client.request(`projects/${project.id}/${kind}s/${plan.id}/${kind}-issues/`, {
    method: "POST",
    body: { issues: [...ids] },
  });
  return { project: project.identifier, id: plan.id, name: plan.name, issues: [...ids] };
};

export const planIssues = async (
  client: PlaneClient,
  args: ParsedArgs,
  kind: PlanningKind,
): Promise<Listing> => {
  const ref = required(args.positionals[0], `a ${kind} name or UUID`);
  const project = await projectFor(client, args);
  const plan = resolveNamed(await plansForResolution(client, project.id, kind), ref, kind);
  const issues = await client.listAll<ExpandedIssue>(
    `projects/${project.id}/${kind}s/${plan.id}/${kind}-issues/`,
    {
      query: { fields: "id,name,sequence_id,priority,state", expand: "state", per_page: 100 },
    },
  );
  const rows = issues.map((issue) => issueToRow(issue, project.identifier));
  return { rows, total: rows.length };
};

export interface Transfer {
  readonly project: string;
  readonly from: Plan;
  readonly to: Plan;
}

export const transferCycle = async (client: PlaneClient, args: ParsedArgs): Promise<Transfer> => {
  const from = required(args.positionals[0], "a source cycle");
  const to = required(args.positionals[1], "a target cycle");
  const project = await projectFor(client, args);
  const cycles = await plansForResolution(client, project.id, "cycle");
  const source = resolveNamed(cycles, from, "cycle");
  const target = resolveNamed(cycles, to, "cycle");
  if (source.id === target.id) throw new UsageError("Source and target cycles must be different.");
  await client.request(`projects/${project.id}/cycles/${source.id}/transfer-issues/`, {
    method: "POST",
    body: { new_cycle_id: target.id },
  });
  return { project: project.identifier, from: source, to: target };
};

const calendarDate = (value: string | null | undefined, timezone?: string): string => {
  if (value == null) return "?";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) || timezone === undefined) return value;
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value));
  } catch {
    // Preserve the full timestamp if its timezone or date cannot be interpreted.
    return value;
  }
};

export const formatPlan = (plan: Plan): string => {
  const end = plan.end_date ?? plan.target_date;
  const dates =
    plan.start_date == null && end == null
      ? ""
      : `  ${calendarDate(plan.start_date, plan.timezone)} / ${calendarDate(end, plan.timezone)}`;
  return `${oneLine(plan.name)}  ${plan.id}${dates}${plan.status === undefined ? "" : ` (${plan.status})`}`;
};

export const formatPlans = (plans: ReadonlyArray<Plan>): string =>
  plans.length === 0 ? "no entries" : plans.map(formatPlan).join("\n");
export const formatPlanChange = (change: PlanChange): string =>
  `added ${change.issues.length} work items to ${oneLine(change.name)}`;
export const formatTransfer = (transfer: Transfer): string =>
  printColumns(
    [
      { name: "from", text: oneLine(transfer.from.name) },
      { name: "to", text: oneLine(transfer.to.name) },
    ],
    "",
  ).join("\n");
