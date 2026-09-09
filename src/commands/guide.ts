/*
 * The map. One call tells a fresh session what exists and in what order it is
 * usually done — the thing a --help listing cannot say, because help sorts
 * alphabetically and lists every flag.
 */

import { printColumns } from "../output.ts";

export interface Entry {
  readonly command: string;
  readonly summary: string;
}

export interface Group {
  readonly title: string;
  readonly commands: ReadonlyArray<Entry>;
}

export interface GuideReport {
  readonly map: ReadonlyArray<Group>;
  readonly flow: ReadonlyArray<Entry>;
}

/* Groups follow the order of work, not the alphabet. */
export const MAP: ReadonlyArray<Group> = [
  {
    title: "LOOK AROUND",
    commands: [
      { command: "i-plane", summary: "Workspace summary: projects and their counts." },
      { command: "projects", summary: "List projects with identifiers." },
      { command: "list [project]", summary: "Work items, one line each. Alias: ls" },
      { command: "show <ID>", summary: "One work item: CLOUD-8." },
      { command: "search <text>", summary: "Search across the workspace. Alias: find" },
    ],
  },
  {
    title: "CHANGE THINGS",
    commands: [
      { command: "create <title>", summary: "Create a work item. Alias: new" },
      { command: "update <ID> [flags]", summary: "Change state, priority, title. Alias: set" },
      { command: "done <ID>", summary: "Move to the first completed state." },
      { command: "comment <ID> <text>", summary: "Add a comment." },
      { command: "delete <ID>", summary: "Delete a work item. Needs --yes. Alias: rm" },
    ],
  },
  {
    title: "PROJECT SHAPE",
    commands: [
      { command: "states [project]", summary: "States of a project and their groups." },
      { command: "labels [project]", summary: "Labels of a project." },
      { command: "members", summary: "Who is in the workspace." },
    ],
  },
  {
    title: "SELF",
    commands: [
      { command: "config", summary: "Where url, token and workspace came from." },
      { command: "guide", summary: "This map." },
      { command: "whoami", summary: "The account behind the token." },
    ],
  },
];

export const FLOW: ReadonlyArray<Entry> = [
  { command: "i-plane", summary: "Start here. It names the projects you can work in." },
  { command: "list CLOUD", summary: "See the work items. Add --state or --priority to narrow." },
  { command: "show CLOUD-8", summary: "Read one before changing it." },
  { command: "update", summary: "Change what you meant; done is a shortcut for update --state." },
  { command: "--json", summary: "Every command takes it when you need all the fields." },
  { command: "config", summary: "When something targets the wrong place, look here first." },
];

export const guideReport = (): GuideReport => ({ map: MAP, flow: FLOW });

export const formatGuide = (report: GuideReport): string => {
  const lines: string[] = [];
  for (const [index, group] of report.map.entries()) {
    if (index > 0) lines.push("");
    lines.push(group.title);
    lines.push(...printColumns(group.commands.map((e) => ({ name: e.command, text: e.summary }))));
  }
  lines.push("", "FLOW");
  lines.push(...printColumns(report.flow.map((e) => ({ name: e.command, text: e.summary }))));
  return lines.join("\n");
};
