/*
 * The guide, and the per-command help.
 *
 * Both are rendered from the registry, so a flag cannot exist without being
 * documented, and a documented flag cannot stop existing quietly.
 *
 * The guide is what `i-plane` prints with no arguments. That choice is
 * deliberate: the first call of a session should teach how the tool behaves,
 * not answer a question nobody asked yet.
 */

import { printColumns } from "../output.ts";
import type { Command, Option } from "../registry.ts";
import { FLOW, GLOBAL_OPTIONS, GROUPS, NOTES } from "../registry.ts";

export interface GuideReport {
  readonly groups: typeof GROUPS;
  readonly flow: typeof FLOW;
  readonly notes: typeof NOTES;
  readonly globalOptions: typeof GLOBAL_OPTIONS;
}

export const guideReport = (): GuideReport => ({
  groups: GROUPS,
  flow: FLOW,
  notes: NOTES,
  globalOptions: GLOBAL_OPTIONS,
});

const label = (command: Command): string =>
  `${command.name}${command.args === undefined ? "" : ` ${command.args}`}`;

/** Wraps prose so a terminal at eighty columns stays readable. */
const wrap = (text: string, width: number, indent: string): ReadonlyArray<string> => {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (`${current} ${word}`.length + indent.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(indent + current);
      current = word;
    }
  }
  if (current !== "") lines.push(indent + current);
  return lines;
};

export const formatGuide = (report: GuideReport): string => {
  const lines: string[] = [];

  for (const group of report.groups) {
    lines.push(group.title);
    if (group.summary !== undefined) lines.push(...wrap(group.summary, 96, "  "), "");
    lines.push(
      ...printColumns(
        group.commands.map((command) => ({
          name: label(command),
          text:
            command.alias === undefined
              ? command.summary
              : `${command.summary}  (alias: ${command.alias})`,
        })),
      ),
    );
    lines.push("");
  }

  lines.push("FLOW");
  lines.push(
    ...printColumns(report.flow.map((step) => ({ name: step.command, text: step.summary }))),
  );
  lines.push("");

  lines.push(formatGlobalOptions(report.globalOptions), "");
  lines.push("HOW THIS TOOL BEHAVES");
  for (const note of report.notes) {
    lines.push(`  ${note.title}`);
    lines.push(...wrap(note.body, 96, "    "));
    lines.push("");
  }

  lines.push("Flags and examples for one command: i-plane <command> --help");
  return lines.join("\n");
};

export interface CommandHelp {
  readonly command: Command;
  readonly globalOptions?: ReadonlyArray<Option>;
}

export const formatGlobalOptions = (options: ReadonlyArray<Option> = GLOBAL_OPTIONS): string =>
  [
    "GLOBAL OPTIONS",
    ...printColumns(
      options.map((option) => ({
        name: `${option.flag}${option.value === undefined ? "" : ` ${option.value}`}`,
        text: option.summary,
      })),
    ),
  ].join("\n");

export const formatCommandHelp = (help: CommandHelp, includeGlobals = true): string => {
  const { command } = help;
  const lines: string[] = [`i-plane ${label(command)}`, "", ...wrap(command.summary, 96, "  ")];

  if (command.alias !== undefined) {
    lines.push("", `  alias: ${command.alias}`);
  }

  const localOptions = (command.options ?? []).filter((option) => option.flag !== "--json");
  if (localOptions.length > 0) {
    lines.push("", "OPTIONS");
    lines.push(
      ...printColumns(
        localOptions.map((option) => ({
          name: option.value === undefined ? option.flag : `${option.flag} ${option.value}`,
          text: `${option.required === true ? "Required. " : ""}${option.summary}`,
        })),
      ),
    );
  }

  if (command.notes !== undefined && command.notes.length > 0) {
    lines.push("", "USAGE NOTES");
    for (const note of command.notes) lines.push(...wrap(note, 96, "  "), "");
    if (lines[lines.length - 1] === "") lines.pop();
  }

  if (command.examples !== undefined && command.examples.length > 0) {
    lines.push("", "EXAMPLES");
    for (const example of command.examples) lines.push(`  ${example}`);
  }

  if (command.next !== undefined && command.next.length > 0) {
    lines.push("", "USUALLY NEXT");
    for (const step of command.next) lines.push(`  ${step}`);
  }

  if (includeGlobals) lines.push("", formatGlobalOptions(help.globalOptions));

  return lines.join("\n");
};

/**
 * Printed when a call is missing something. A bare complaint makes the caller
 * guess; this shows the real invocation and what narrowing is available, so the
 * second attempt is informed rather than another guess.
 */
export const formatHint = (command: Command, problem: string): string => {
  const lines = [problem, "", `  i-plane ${label(command)}`];

  if (command.examples !== undefined && command.examples.length > 0) {
    lines.push("");
    for (const example of command.examples) lines.push(`  ${example}`);
  }

  const narrowing = (command.options ?? []).filter(
    (option) => option.flag !== "--json" && option.value !== undefined,
  );
  if (narrowing.length > 0) {
    lines.push("", "  flags:");
    lines.push(
      ...printColumns(
        narrowing.map((option) => ({
          name: `${option.flag} ${option.value}`,
          text: `${option.required === true ? "Required. " : ""}${option.summary}`,
        })),
        "    ",
      ),
    );
  }

  lines.push("", `  full help: i-plane ${command.name} --help`);
  return lines.join("\n");
};
