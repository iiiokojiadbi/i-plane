/*
 * Turning what a human types into what the API wants.
 *
 * Plane addresses everything by uuid, but people and agents say CLOUD-8. The
 * REST API resolves that in one request — /workspaces/<slug>/issues/CLOUD-8/ —
 * where Plane's own MCP server needs two. Same for projects: a short identifier
 * or a name prefix beats pasting a uuid.
 */

import { UsageError } from "./args.ts";
import type { PlaneClient } from "./client.ts";
import type { Issue, Project, State } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READABLE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

export const isUuid = (value: string): boolean => UUID.test(value);

/** Cheapest listing of projects: identifier and name, nothing else. */
export const listProjects = (
  client: PlaneClient,
  fields = "id,name,identifier",
): Promise<ReadonlyArray<Project>> =>
  client.listAll<Project>("projects/", {
    query: { fields, per_page: 100 },
  });

/**
 * Accepts a uuid, a project identifier (CLOUD), or a unique name prefix.
 * Ambiguity is reported rather than guessed: picking one of two silently is how
 * work items land in the wrong project.
 */
export const resolveProject = async (
  client: PlaneClient,
  ref: string,
  fields = "id,name,identifier",
): Promise<Project> => {
  if (isUuid(ref)) {
    return client.request<Project>(`projects/${ref}/`, {
      query: { fields },
    });
  }

  const projects = await listProjects(client, fields);
  const needle = ref.toLowerCase();

  const byIdentifier = projects.filter((p) => p.identifier.toLowerCase() === needle);
  if (byIdentifier.length === 1 && byIdentifier[0] !== undefined) return byIdentifier[0];

  const byName = projects.filter((p) => p.name.toLowerCase() === needle);
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];

  const byPrefix = projects.filter((p) => p.name.toLowerCase().startsWith(needle));
  if (byPrefix.length === 1 && byPrefix[0] !== undefined) return byPrefix[0];

  if (byPrefix.length > 1) {
    const names = byPrefix.map((p) => `${p.identifier} (${p.name})`).join(", ");
    throw new UsageError(`"${ref}" matches several projects: ${names}`);
  }

  const known = projects.map((p) => p.identifier).join(", ");
  throw new UsageError(`No project matches "${ref}". Known: ${known || "none"}`);
};

export interface ResolvedIssue {
  readonly issue: Issue;
  readonly projectId: string;
}

/** Accepts CLOUD-8 or a uuid; a uuid needs a project to look under. */
export const resolveIssue = async (
  client: PlaneClient,
  ref: string,
  projectRef?: string,
  fields = "id,name,sequence_id,state,priority,project,assignees,target_date,parent,labels",
): Promise<ResolvedIssue> => {
  const readable = READABLE.exec(ref);
  if (readable !== null) {
    const issue = await client.request<Issue>(`issues/${ref.toUpperCase()}/`, {
      query: { fields },
    });
    return { issue, projectId: issue.project };
  }

  if (!isUuid(ref)) {
    throw new UsageError(`"${ref}" is neither a readable identifier like CLOUD-8 nor a uuid.`);
  }
  if (projectRef === undefined) {
    throw new UsageError(`A uuid needs --project so the work item can be found.`);
  }

  const project = await resolveProject(client, projectRef);
  const issue = await client.request<Issue>(`projects/${project.id}/issues/${ref}/`, {
    query: { fields },
  });
  return { issue, projectId: project.id };
};

/** States are needed to print names instead of uuids, and to move work items. */
export const listStates = (client: PlaneClient, projectId: string): Promise<ReadonlyArray<State>> =>
  client.listAll<State>(`projects/${projectId}/states/`, {
    query: { fields: "id,name,group,default", per_page: 100 },
  });

export const stateIndex = async (
  client: PlaneClient,
  projectId: string,
): Promise<ReadonlyMap<string, State>> => {
  const states = await listStates(client, projectId);
  return new Map(states.map((state) => [state.id, state]));
};

/** Finds a state by name, then by group, so `--state done` works either way. */
export const findState = (states: ReadonlyArray<State>, ref: string): State => {
  const needle = ref.toLowerCase();
  const byName = states.find((s) => s.name.toLowerCase() === needle);
  if (byName !== undefined) return byName;
  const byPrefix = states.filter((s) => s.name.toLowerCase().startsWith(needle));
  if (byPrefix.length === 1 && byPrefix[0] !== undefined) return byPrefix[0];
  const byGroup = states.filter((s) => s.group.toLowerCase() === needle);
  if (byGroup.length >= 1 && byGroup[0] !== undefined) return byGroup[0];
  const known = states.map((s) => `${s.name} (${s.group})`).join(", ");
  throw new UsageError(`No state matches "${ref}". This project has: ${known}`);
};

/** Select one resource by ID, exact name, or unique prefix; never guess a tie. */
export const resolveNamed = <T extends { readonly id: string; readonly name: string }>(
  rows: ReadonlyArray<T>,
  ref: string,
  category: string,
): T => {
  const needle = ref.toLowerCase();
  const byId = rows.find((row) => row.id === ref);
  if (byId !== undefined) return byId;
  const exact = rows.filter((row) => row.name.toLowerCase() === needle);
  const matches =
    exact.length > 0 ? exact : rows.filter((row) => row.name.toLowerCase().startsWith(needle));
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length > 1)
    throw new UsageError(
      `Ambiguous ${category} "${ref}": ${matches.map((row) => `${row.name} (${row.id})`).join(", ")}`,
    );
  throw new UsageError(`No ${category} matches "${ref}".`);
};
