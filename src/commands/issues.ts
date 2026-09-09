/*
 * Work item commands.
 *
 * Every listing asks the server for `fields` and `expand` rather than taking the
 * default answer: on this instance that turns 11 KB into 737 bytes for the same
 * three items. What the formatter then prints is a line each.
 */

import { flagBool, flagNumber, flagValue, type ParsedArgs, UsageError } from "../args.ts";
import type { PlaneClient } from "../client.ts";
import { oneLine, printColumns, truncate, warn } from "../output.ts";
import { findState, listStates, resolveIssue, resolveProject } from "../resolve.ts";
import { htmlToMarkdown, markdownToHtml } from "../richtext.ts";
import type { Issue, State } from "../types.ts";
import { priorityRank, stateGroupRank } from "../types.ts";

/** A work item as this CLI thinks of it: six fields, not twenty-nine. */
export interface Row {
  readonly ref: string;
  readonly name: string;
  readonly state: string;
  readonly group: string;
  readonly priority: string;
  readonly id: string;
}

interface Expanded extends Omit<Issue, "state"> {
  readonly state: State | string;
}

const LIST_FIELDS = "id,name,sequence_id,priority,state";

const stateOf = (issue: Expanded): { name: string; group: string } =>
  typeof issue.state === "object" && issue.state !== null
    ? { name: issue.state.name, group: issue.state.group }
    : { name: "?", group: "?" };

const toRow = (issue: Expanded, identifier: string): Row => {
  const state = stateOf(issue);
  return {
    ref: `${identifier}-${issue.sequence_id}`,
    name: oneLine(issue.name),
    state: state.name,
    group: state.group,
    priority: issue.priority,
    id: issue.id,
  };
};

/** Priority is only worth showing when it is set; "none" is noise on every line. */
const priorityTag = (priority: string): string =>
  priority === "none" || priority === "" ? "" : ` [${priority}]`;

export const formatListing = (listing: Listing): string => {
  const { rows, total } = listing;
  if (rows.length === 0) {
    // "no work items" would be a lie when --limit hid all of them.
    return total === 0 ? "no work items" : `showing 0 of ${total} — raise or drop --limit`;
  }
  const lines = [
    ...printColumns(
      rows.map((row) => ({
        name: row.ref,
        text: `${truncate(row.name, 72)}${priorityTag(row.priority)} (${row.state})`,
      })),
      "",
    ),
  ];
  // Saying so out loud matters: a truncated list looks exactly like a complete
  // one, and acting on a partial picture is worse than making a second call.
  if (rows.length < total) {
    lines.push("", `showing ${rows.length} of ${total} — drop --limit to see the rest`);
  }
  return lines.join("\n");
};

export interface Listing {
  readonly rows: ReadonlyArray<Row>;
  /** How many matched before --limit cut the list. */
  readonly total: number;
}

export const listIssues = async (client: PlaneClient, args: ParsedArgs): Promise<Listing> => {
  const projectRef = args.positionals[0] ?? flagValue(args, "project");
  if (projectRef === undefined) {
    throw new UsageError("Which project?");
  }
  const project = await resolveProject(client, projectRef);

  // Only fields and expand are honoured by this endpoint. state_group, priority
  // and order_by are accepted with 200 and then ignored — the answer comes back
  // whole either way. So narrowing happens here, on rows already made small.
  const limit = flagNumber(args, "limit");
  const issues = await client.listAll<Expanded>(`projects/${project.id}/issues/`, {
    query: { fields: LIST_FIELDS, expand: "state", per_page: 100 },
  });

  const wantState = flagValue(args, "state")?.toLowerCase();
  const wantPriority = flagValue(args, "priority")?.toLowerCase();

  const rows = issues
    .map((issue) => toRow(issue, project.identifier))
    .filter((row) => {
      // --state matches either the group (started) or the name (In Progress).
      if (wantState !== undefined) {
        const hit =
          row.group.toLowerCase() === wantState || row.state.toLowerCase().startsWith(wantState);
        if (!hit) return false;
      }
      if (wantPriority !== undefined && row.priority.toLowerCase() !== wantPriority) return false;
      return true;
    });
  // Open work first, then by priority: the order someone actually reads them in.
  const sorted = [...rows].sort(
    (a, b) =>
      stateGroupRank(a.group) - stateGroupRank(b.group) ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      a.ref.localeCompare(b.ref),
  );
  // Trimming happens after sorting: --limit should keep the rows that matter,
  // not whichever ones the server happened to send first.
  return {
    rows: limit === undefined ? sorted : sorted.slice(0, limit),
    total: sorted.length,
  };
};

export interface Detail extends Row {
  readonly description: string;
  readonly assignees: ReadonlyArray<string>;
  readonly target_date?: string | null;
  readonly parent?: string | null;
  readonly url: string;
}

export const showIssue = async (
  client: PlaneClient,
  args: ParsedArgs,
  workspace: string,
  baseUrl: string,
): Promise<Detail> => {
  const ref = args.positionals[0];
  if (ref === undefined) throw new UsageError("Which work item?");

  const { issue, projectId } = await resolveIssue(
    client,
    ref,
    flagValue(args, "project"),
    "id,name,sequence_id,priority,state,assignees,target_date,parent,project,description_html",
  );
  const states = await listStates(client, projectId);
  const state = states.find((s) => s.id === issue.state);
  const project = await resolveProject(client, projectId);

  return {
    ref: `${project.identifier}-${issue.sequence_id}`,
    name: oneLine(issue.name),
    state: state?.name ?? "?",
    group: state?.group ?? "?",
    priority: issue.priority,
    id: issue.id,
    description: htmlToMarkdown(issue.description_html),
    assignees: issue.assignees ?? [],
    target_date: issue.target_date ?? null,
    parent: issue.parent ?? null,
    url: `${baseUrl}/${workspace}/projects/${projectId}/issues/${issue.id}`,
  };
};

export const formatDetail = (detail: Detail): string => {
  const rows: Array<{ name: string; text: string }> = [
    { name: detail.ref, text: detail.name },
    { name: "state", text: `${detail.state} (${detail.group})` },
    { name: "priority", text: detail.priority },
  ];
  if (detail.target_date != null) rows.push({ name: "due", text: detail.target_date });
  if (detail.assignees.length > 0) {
    rows.push({ name: "assignees", text: String(detail.assignees.length) });
  }
  if (detail.parent != null) rows.push({ name: "parent", text: detail.parent });
  rows.push({ name: "url", text: detail.url });
  const head = printColumns(rows, "").join("\n");
  // The description goes below the fields, as Markdown: code blocks and tables
  // are why anyone opens a work item, and HTML is unreadable for both of us.
  return detail.description === "" ? head : `${head}\n\n${detail.description}`;
};

export const createIssue = async (client: PlaneClient, args: ParsedArgs): Promise<Row> => {
  const title = args.positionals.join(" ").trim();
  if (title === "") throw new UsageError("What is it called?");

  const projectRef = flagValue(args, "project");
  if (projectRef === undefined) {
    throw new UsageError("Which project? Pass --project.");
  }
  const project = await resolveProject(client, projectRef);

  const body: Record<string, unknown> = { name: title };
  const description = flagValue(args, "description");
  // Written as Markdown, stored as HTML: Plane keeps whatever markup it is given,
  // so code blocks, tables and lists all survive the round trip.
  if (description !== undefined) body.description_html = markdownToHtml(description);
  const priority = flagValue(args, "priority");
  if (priority !== undefined) body.priority = priority;

  const state = flagValue(args, "state");
  if (state !== undefined) {
    const states = await listStates(client, project.id);
    body.state = findState(states, state).id;
  }

  const created = await client.request<Issue>(`projects/${project.id}/issues/`, {
    method: "POST",
    body,
  });
  const ref = `${project.identifier}-${created.sequence_id}`;

  /*
   * The work item exists from here on. Reading its state is a nicety, and a
   * failure there must not be reported as a failure to create: a caller who
   * retries on that error ends up with duplicates.
   */
  let created_state: State | undefined;
  try {
    const states = await listStates(client, project.id);
    created_state = states.find((s) => s.id === created.state);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    warn(`${ref} was created; could not read its state: ${reason}`);
  }

  return {
    ref,
    name: oneLine(created.name),
    state: created_state?.name ?? "?",
    group: created_state?.group ?? "?",
    priority: created.priority,
    id: created.id,
  };
};

export const updateIssue = async (client: PlaneClient, args: ParsedArgs): Promise<Row> => {
  const ref = args.positionals[0];
  if (ref === undefined) throw new UsageError("Which work item?");

  const { issue, projectId } = await resolveIssue(client, ref, flagValue(args, "project"));
  const project = await resolveProject(client, projectId);
  const states = await listStates(client, projectId);

  const body: Record<string, unknown> = {};
  const state = flagValue(args, "state");
  if (state !== undefined) body.state = findState(states, state).id;
  const priority = flagValue(args, "priority");
  if (priority !== undefined) body.priority = priority;
  const name = flagValue(args, "name");
  if (name !== undefined) body.name = name;
  const description = flagValue(args, "description");
  if (description !== undefined) body.description_html = markdownToHtml(description);

  if (Object.keys(body).length === 0) {
    throw new UsageError("Nothing to change. Pass --state, --priority, --name or --description.");
  }

  await client.request(`projects/${projectId}/issues/${issue.id}/`, { method: "PATCH", body });
  const after = await client.request<Issue>(`projects/${projectId}/issues/${issue.id}/`, {
    query: { fields: "id,name,sequence_id,priority,state" },
  });
  const nowState = states.find((s) => s.id === after.state);
  return {
    ref: `${project.identifier}-${after.sequence_id}`,
    name: oneLine(after.name),
    state: nowState?.name ?? "?",
    group: nowState?.group ?? "?",
    priority: after.priority,
    id: after.id,
  };
};

/** done is set --state <first completed state>, spelled the way people say it. */
export const completeIssue = async (client: PlaneClient, args: ParsedArgs): Promise<Row> => {
  const ref = args.positionals[0];
  if (ref === undefined) throw new UsageError("Which work item?");
  const { projectId } = await resolveIssue(client, ref, flagValue(args, "project"));
  const states = await listStates(client, projectId);
  const completed = states.find((s) => s.group === "completed");
  if (completed === undefined) {
    throw new UsageError("This project has no state in the completed group.");
  }
  const next = new Map(args.flags);
  next.set("state", completed.name);
  return updateIssue(client, { ...args, flags: next });
};

export const deleteIssue = async (client: PlaneClient, args: ParsedArgs): Promise<string> => {
  const ref = args.positionals[0];
  if (ref === undefined) throw new UsageError("Which work item?");
  if (!flagBool(args, "yes")) {
    throw new UsageError(`Deleting is not undoable. Repeat with --yes to delete ${ref}.`);
  }
  const { issue, projectId } = await resolveIssue(client, ref, flagValue(args, "project"));
  await client.request(`projects/${projectId}/issues/${issue.id}/`, { method: "DELETE" });
  return `deleted ${ref}`;
};

export const commentIssue = async (client: PlaneClient, args: ParsedArgs): Promise<string> => {
  const ref = args.positionals[0];
  const text = args.positionals.slice(1).join(" ").trim();
  if (ref === undefined || text === "") {
    throw new UsageError("Which work item, and what does the comment say?");
  }
  const { issue, projectId } = await resolveIssue(client, ref, flagValue(args, "project"));
  await client.request(`projects/${projectId}/issues/${issue.id}/comments/`, {
    method: "POST",
    // Markdown, as the guide promises. Wrapping raw text in <p> passed literal
    // markup straight through into stored HTML.
    body: { comment_html: markdownToHtml(text) },
  });
  return `commented on ${ref}`;
};

export interface Found {
  readonly ref: string;
  readonly name: string;
  readonly id: string;
}

/**
 * Workspace-wide search. Plane's own MCP server has no equivalent — it can only
 * list one project at a time.
 */
export const findIssues = async (
  client: PlaneClient,
  args: ParsedArgs,
): Promise<ReadonlyArray<Found>> => {
  const text = args.positionals.join(" ").trim();
  if (text === "") throw new UsageError("What to search for?");
  const answer = await client.request<{
    issues?: ReadonlyArray<{
      id: string;
      name: string;
      sequence_id: number;
      project__identifier: string;
    }>;
  }>("issues/search/", { query: { search: text } });
  return (answer.issues ?? []).map((hit) => ({
    ref: `${hit.project__identifier}-${hit.sequence_id}`,
    name: oneLine(hit.name),
    id: hit.id,
  }));
};

export const formatFound = (hits: ReadonlyArray<Found>): string =>
  hits.length === 0
    ? "nothing found"
    : printColumns(
        hits.map((hit) => ({ name: hit.ref, text: truncate(hit.name, 80) })),
        "",
      ).join("\n");
