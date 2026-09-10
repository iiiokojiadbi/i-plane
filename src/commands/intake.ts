import { flagBool, flagValue, type ParsedArgs, UsageError } from "../args.ts";
import { type PlaneClient, PlaneError } from "../client.ts";
import { oneLine, printColumns } from "../output.ts";
import { isUuid, resolveIssue, resolveProject } from "../resolve.ts";
import { htmlToMarkdown, markdownToHtml } from "../richtext.ts";
import { type Issue, PRIORITY_ORDER, type Project } from "../types.ts";
import { choice, dateValue, requireChanges, required, requiredFlag } from "../validation.ts";

const INTAKE_STATUS: Readonly<Record<string, number>> = {
  pending: -2,
  rejected: -1,
  snoozed: 0,
  accepted: 1,
  duplicate: 2,
};
interface IntakeItem {
  readonly id: string;
  readonly issue: string | Issue;
  readonly issue_detail?: Issue;
  readonly status: number;
  readonly snoozed_till?: string | null;
  readonly duplicate_to?: string | null;
}
export interface IntakeRow {
  readonly id: string;
  readonly issueId: string;
  readonly ref: string;
  readonly name: string;
  readonly status: string;
  readonly statusCode: number;
  readonly priority: string;
  readonly description: string;
  readonly snoozedUntil: string | null;
  readonly duplicateTo: string | null;
}

const toRow = (item: IntakeItem, project: Project): IntakeRow => {
  const issue = item.issue_detail ?? (typeof item.issue === "object" ? item.issue : undefined);
  const issueId = typeof item.issue === "string" ? item.issue : item.issue.id;
  return {
    id: item.id,
    issueId,
    ref: issue?.sequence_id === undefined ? issueId : `${project.identifier}-${issue.sequence_id}`,
    name: oneLine(issue?.name ?? issueId),
    status:
      Object.entries(INTAKE_STATUS).find(([, code]) => code === item.status)?.[0] ??
      String(item.status),
    statusCode: item.status,
    priority: issue?.priority ?? "none",
    description: htmlToMarkdown(issue?.description_html),
    snoozedUntil: item.snoozed_till ?? null,
    duplicateTo: item.duplicate_to ?? null,
  };
};

const intakeRows = (client: PlaneClient, projectId: string): Promise<ReadonlyArray<IntakeItem>> =>
  client.listAll<IntakeItem>(`projects/${projectId}/intake-issues/`, { query: { per_page: 100 } });

const resolveIntake = async (
  client: PlaneClient,
  project: Project,
  ref: string,
): Promise<IntakeItem> => {
  // The detail endpoint takes the underlying work item UUID, not the intake row UUID.
  if (isUuid(ref))
    return client.request<IntakeItem>(`projects/${project.id}/intake-issues/${ref}/`);
  const items = await intakeRows(client, project.id);
  const item = items.find((entry) => toRow(entry, project).ref.toLowerCase() === ref.toLowerCase());
  if (item === undefined)
    throw new UsageError(
      `No intake work item matches "${ref}". Use its readable reference or underlying work item UUID.`,
    );
  return item;
};

export interface IntakeTarget {
  readonly issueId: string;
  readonly ref: string;
}

/** Writes must not depend on intake GET: expired snoozes are hidden there. */
const resolveIntakeTarget = async (
  client: PlaneClient,
  project: Project,
  ref: string,
): Promise<IntakeTarget> => {
  if (isUuid(ref)) return { issueId: ref, ref };
  const visible = (await intakeRows(client, project.id)).find(
    (item) => toRow(item, project).ref.toLowerCase() === ref.toLowerCase(),
  );
  if (visible !== undefined) {
    const row = toRow(visible, project);
    return { issueId: row.issueId, ref: row.ref };
  }
  // Accepted work can resolve through the normal endpoint. Triage work may be
  // hidden there too; do not claim that changing to this endpoint always works.
  try {
    const resolved = await resolveIssue(client, ref, project.id, "id,project,sequence_id");
    if (resolved.projectId !== project.id)
      throw new UsageError(`${ref} does not belong to project ${project.identifier}.`);
    return {
      issueId: resolved.issue.id,
      ref: `${project.identifier}-${resolved.issue.sequence_id}`,
    };
  } catch (error) {
    if (error instanceof PlaneError && error.status === 404)
      throw new UsageError(
        `Cannot resolve intake reference "${ref}". The server can hide expired snoozes from both lookup endpoints. Pass the underlying work item UUID (issueId in JSON).`,
      );
    throw error;
  }
};

const issueBody = (args: ParsedArgs): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  const name = flagValue(args, "name");
  if (name !== undefined) body.name = required(name, "a work item name");
  const priority = flagValue(args, "priority");
  if (priority !== undefined) body.priority = choice(priority, PRIORITY_ORDER, "priority");
  const description = flagValue(args, "description");
  if (description !== undefined) body.description_html = markdownToHtml(description);
  return body;
};

export const listIntake = async (
  client: PlaneClient,
  args: ParsedArgs,
): Promise<ReadonlyArray<IntakeRow>> => {
  const status = flagValue(args, "status");
  const selected =
    status === undefined ? undefined : choice(status, Object.keys(INTAKE_STATUS), "status");
  const project = await resolveProject(
    client,
    required(args.positionals[0] ?? flagValue(args, "project"), "a project reference"),
  );
  const rows = (await intakeRows(client, project.id)).map((item) => toRow(item, project));
  return selected === undefined ? rows : rows.filter((row) => row.status === selected);
};

export const createIntake = async (client: PlaneClient, args: ParsedArgs): Promise<IntakeRow> => {
  const name = required(args.positionals.join(" "), "an intake work item name");
  const body = { issue: { ...issueBody(args), name } };
  const project = await resolveProject(client, requiredFlag(args, "project"));
  const item = await client.request<IntakeItem>(`projects/${project.id}/intake-issues/`, {
    method: "POST",
    body,
  });
  return toRow(item, project);
};

export const showIntake = async (client: PlaneClient, args: ParsedArgs): Promise<IntakeRow> => {
  const ref = required(args.positionals[0], "an intake work item reference");
  const project = await resolveProject(client, requiredFlag(args, "project"));
  return toRow(await resolveIntake(client, project, ref), project);
};

export const updateIntake = async (client: PlaneClient, args: ParsedArgs): Promise<IntakeRow> => {
  const ref = required(args.positionals[0], "an intake work item reference");
  const body: Record<string, unknown> = {};
  const fields = issueBody(args);
  if (Object.keys(fields).length > 0) body.issue = fields;
  const rawStatus = flagValue(args, "status");
  const status =
    rawStatus === undefined ? undefined : choice(rawStatus, Object.keys(INTAKE_STATUS), "status");
  const snooze = flagValue(args, "snooze-until");
  const duplicate = flagValue(args, "duplicate-of");
  if (snooze !== undefined && status !== "snoozed")
    throw new UsageError("--snooze-until requires --status snoozed.");
  if (duplicate !== undefined && status !== "duplicate")
    throw new UsageError("--duplicate-of requires --status duplicate.");
  if (status !== undefined) {
    body.status = INTAKE_STATUS[status];
    body.snoozed_till = null;
    body.duplicate_to = null;
  }
  if (status === "snoozed") {
    const date = dateValue(required(snooze, "--snooze-until YYYY-MM-DD"), "snooze-until");
    if (date === null) throw new UsageError("A snoozed work item needs a date, not none.");
    body.snoozed_till = `${date}T00:00:00Z`;
  }
  if (status === "duplicate") required(duplicate, "--duplicate-of <ID>");
  requireChanges(body);
  const project = await resolveProject(client, requiredFlag(args, "project"));
  const row = await resolveIntakeTarget(client, project, ref);
  if (duplicate !== undefined) {
    const target = await resolveIssue(client, duplicate, project.id);
    if (target.projectId !== project.id)
      throw new UsageError("The duplicate target must belong to the same project.");
    if (target.issue.id === row.issueId)
      throw new UsageError("A work item cannot be a duplicate of itself.");
    body.duplicate_to = target.issue.id;
  }
  const updated = await client.request<IntakeItem>(
    `projects/${project.id}/intake-issues/${row.issueId}/`,
    { method: "PATCH", body },
  );
  return toRow(updated, project);
};

export const deleteIntake = async (
  client: PlaneClient,
  args: ParsedArgs,
): Promise<IntakeTarget> => {
  if (!flagBool(args, "yes")) throw new UsageError("Deleting cannot be undone. Repeat with --yes.");
  const ref = required(args.positionals[0], "an intake work item reference");
  const project = await resolveProject(client, requiredFlag(args, "project"));
  const row = await resolveIntakeTarget(client, project, ref);
  await client.request(`projects/${project.id}/intake-issues/${row.issueId}/`, {
    method: "DELETE",
  });
  return row;
};

export const formatIntakeList = (rows: ReadonlyArray<IntakeRow>): string =>
  rows.length === 0
    ? "no intake work items"
    : printColumns(
        rows.map((row) => ({
          name: row.ref,
          text: `${row.name} [${row.priority}] (${row.status})`,
        })),
        "",
      ).join("\n");
export const formatIntake = (row: IntakeRow): string => {
  const head = formatIntakeList([row]);
  return `${head}${row.snoozedUntil === null ? "" : `\nsnoozed until ${row.snoozedUntil}`}${row.duplicateTo === null ? "" : `\nduplicate of ${row.duplicateTo}`}${row.description === "" ? "" : `\n\n${row.description}`}`;
};
