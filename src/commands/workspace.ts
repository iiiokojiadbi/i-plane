/*
 * Workspace-level commands, plus the no-argument summary.
 *
 * The summary leans on /projects/<id>/summary/, which returns counts already
 * aggregated — cheaper and shorter than listing anything and counting locally.
 * Plane's MCP server does not expose it at all.
 */

import { flagValue, type ParsedArgs, UsageError } from "../args.ts";
import type { PlaneClient } from "../client.ts";
import type { Config } from "../config.ts";
import { maskToken } from "../config.ts";
import { oneLine, printColumns } from "../output.ts";
import { listProjects, listStates, resolveProject } from "../resolve.ts";
import type { Member, Project, State } from "../types.ts";
import { stateGroupRank } from "../types.ts";

export interface Counts {
  readonly issues: number;
  readonly cycles: number;
  readonly modules: number;
  readonly members: number;
  readonly labels: number;
  readonly states: number;
  readonly pages?: number;
  readonly intakes?: number;
}

export interface ProjectSummary {
  readonly identifier: string;
  readonly name: string;
  readonly counts: Counts;
}

export interface Summary {
  readonly workspace: string;
  readonly url: string;
  readonly projects: ReadonlyArray<ProjectSummary>;
}

export const summarize = async (client: PlaneClient, config: Config): Promise<Summary> => {
  const projects = await listProjects(client);
  const summaries = await Promise.all(
    projects.map(async (project) => {
      const detail = await client.request<{ counts: Counts }>(`projects/${project.id}/summary/`);
      return { identifier: project.identifier, name: project.name, counts: detail.counts };
    }),
  );
  return {
    workspace: config.workspace.value,
    url: config.url.value,
    projects: summaries,
  };
};

export const formatSummary = (summary: Summary): string => {
  const lines = [`WORKSPACE ${summary.workspace}  ${summary.url}`, ""];
  if (summary.projects.length === 0) {
    lines.push("no projects yet");
  } else {
    lines.push("PROJECTS");
    lines.push(
      ...printColumns(
        summary.projects.map((project) => ({
          name: project.identifier,
          text:
            `${project.name} — ${project.counts.issues} work items, ` +
            `${project.counts.cycles} cycles, ${project.counts.modules} modules`,
        })),
      ),
    );
  }
  lines.push("", "Next: i-plane list <PROJECT>   Map: i-plane guide");
  return lines.join("\n");
};

export const formatProjects = (projects: ReadonlyArray<Project>): string =>
  projects.length === 0
    ? "no projects"
    : printColumns(
        projects.map((p) => ({ name: p.identifier, text: oneLine(p.name) })),
        "",
      ).join("\n");

export const statesOf = async (
  client: PlaneClient,
  args: ParsedArgs,
): Promise<ReadonlyArray<State>> => {
  const ref = args.positionals[0] ?? flagValue(args, "project");
  if (ref === undefined) throw new UsageError("Which project? i-plane states CLOUD");
  const project = await resolveProject(client, ref);
  const states = await listStates(client, project.id);
  return [...states].sort((a, b) => stateGroupRank(a.group) - stateGroupRank(b.group));
};

export const formatStates = (states: ReadonlyArray<State>): string =>
  printColumns(
    states.map((s) => ({ name: s.name, text: s.group + (s.default === true ? " (default)" : "") })),
    "",
  ).join("\n");

export interface Label {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
}

export const labelsOf = async (
  client: PlaneClient,
  args: ParsedArgs,
): Promise<ReadonlyArray<Label>> => {
  const ref = args.positionals[0] ?? flagValue(args, "project");
  if (ref === undefined) throw new UsageError("Which project? i-plane labels CLOUD");
  const project = await resolveProject(client, ref);
  return client.listAll<Label>(`projects/${project.id}/labels/`, {
    query: { fields: "id,name,color", per_page: 100 },
  });
};

export const formatLabels = (labels: ReadonlyArray<Label>): string =>
  labels.length === 0 ? "no labels" : labels.map((l) => l.name).join("\n");

export const membersOf = (client: PlaneClient): Promise<ReadonlyArray<Member>> =>
  client.listAll<Member>("members-lite/", { query: { per_page: 100 } });

export const formatMembers = (members: ReadonlyArray<Member>): string =>
  members.length === 0
    ? "no members"
    : printColumns(
        members.map((m) => ({ name: m.display_name ?? m.id, text: m.email ?? "" })),
        "",
      ).join("\n");

export interface ConfigReport {
  readonly url: { value: string; origin: string };
  readonly workspace: { value: string; origin: string };
  readonly token: { value: string; origin: string };
  readonly configPath: string;
}

export const configReport = (config: Config): ConfigReport => ({
  url: { value: config.url.value, origin: config.url.origin },
  workspace: { value: config.workspace.value, origin: config.workspace.origin },
  token: { value: maskToken(config.token.value), origin: config.token.origin },
  configPath: config.configPath,
});

export const formatConfig = (report: ConfigReport): string =>
  printColumns(
    [
      { name: "url", text: `${report.url.value}  (${report.url.origin})` },
      { name: "workspace", text: `${report.workspace.value}  (${report.workspace.origin})` },
      { name: "token", text: `${report.token.value}  (${report.token.origin})` },
      { name: "file", text: report.configPath },
    ],
    "",
  ).join("\n");

export interface Me {
  readonly id: string;
  readonly email?: string;
  readonly display_name?: string;
}

export const whoami = (client: PlaneClient): Promise<Me> => client.request<Me>("/api/v1/users/me/");

export const formatMe = (me: Me): string =>
  printColumns(
    [
      { name: "name", text: me.display_name ?? "?" },
      { name: "email", text: me.email ?? "?" },
      { name: "id", text: me.id },
    ],
    "",
  ).join("\n");
