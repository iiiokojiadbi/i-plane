import { describe, expect, test } from "bun:test";
import { isPageCommand } from "../src/page-dispatch.ts";
import { parseCommandArgs } from "../src/args.ts";
import { formatCommandHelp, formatGuide, guideReport } from "../src/commands/guide.ts";
import { ALL_COMMANDS, findCommand, FLOW, GLOBAL_OPTIONS, knownFlags } from "../src/registry.ts";
import { runFixture } from "./fixture.ts";

// The documentation contains single CLI calls with ordinary quoted arguments,
// not shell programs. Parse those examples without evaluating shell syntax.
const words = (line: string): string[] => {
  const result: string[] = [];
  let word = "",
    quote = "",
    active = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
      active = true;
    } else if (char === '"' || char === "'") {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) result.push(word);
      word = "";
      active = false;
    } else {
      word += char;
      active = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in CLI example");
  if (active) result.push(word);
  return result;
};

const commandOf = (line: string) => {
  const argv = words(line);
  expect(argv.shift()).toBe("i-plane");
  const args = parseCommandArgs(argv);
  const command = findCommand(args.path.join(" "));
  expect(command).toBeDefined();
  for (const flag of args.flags.keys()) expect(knownFlags(command!).has(flag)).toBe(true);
  for (const option of command!.options ?? []) {
    if (option.required) expect(args.flags.has(option.flag.slice(2))).toBe(true);
  }
  return { argv, args, command: command! };
};

describe("the guide is complete and executable", () => {
  for (const command of ALL_COMMANDS) {
    test(`${command.name} examples use known flags and supply required options`, () => {
      expect(command.summary.trim().length).toBeGreaterThan(0);
      expect(command.examples?.length).toBeGreaterThan(0);
      for (const example of command.examples ?? [])
        expect(commandOf(example).command.name).toBe(command.name);
      for (const next of command.next ?? []) commandOf(next);
    });
  }
  for (const step of FLOW.filter((step) => !step.command.includes("<command>"))) {
    test(`FLOW is an actionable invocation: ${step.command}`, () => {
      const { args, command } = commandOf(step.command);
      if (command.name === "update")
        expect(
          [...args.flags.keys()].some((name) =>
            ["name", "state", "priority", "description"].includes(name),
          ),
        ).toBe(true);
    });
  }
  test("all new commands have usage notes and a next action", () => {
    for (const command of ALL_COMMANDS.filter(
      (command) =>
        command.name.includes(" ") || ["comments", "cycles", "modules"].includes(command.name),
    )) {
      expect(command.notes?.length).toBeGreaterThan(0);
      expect(command.next?.length).toBeGreaterThan(0);
    }
  });
  test("global options are present in both the guide model and readable help", () => {
    const model = guideReport();
    expect(model.globalOptions).toEqual(GLOBAL_OPTIONS);
    const guide = formatGuide(model);
    const help = formatCommandHelp({ command: findCommand("module create")! });
    for (const option of GLOBAL_OPTIONS) {
      expect(guide).toContain(option.flag);
      expect(help).toContain(option.flag);
    }
    expect(help.match(/--json/g)).toHaveLength(1);
    expect(help).toContain("Required. Project");
  });
  const fixtureArgs = (line: string): string[] => {
    const { argv, command } = commandOf(line);
    const intake = command.name.startsWith("intake ");
    return argv.map((arg, index) => {
      if (["CLOUD", "KB", "APP"].includes(arg)) return "TEST";
      if (/^(CLOUD|KB)-\d+$/.test(arg))
        return intake && argv[index - 1] === "--duplicate-of"
          ? "TEST-2"
          : argv[index - 1] === "--parent"
            ? "TEST-2"
            : "TEST-1";
      if (["Documentation", "Sprint 1", "Next iteration"].includes(arg)) return "First";
      if (arg === "Sprint 2") return "Second";
      if (["Review", "unused"].includes(arg) && command.name.startsWith("state "))
        return "In Progress";
      if (arg === "unused" && command.name === "label rm") return "task";
      return arg;
    });
  };
  for (const command of ALL_COMMANDS.filter(
    (command) => !["guide", "config"].includes(command.name) && !isPageCommand(command.name),
  )) {
    for (const [index, example] of (command.examples ?? []).entries()) {
      test(`${command.name} example ${index + 1} executes against the API fixture`, async () => {
        const { model } = await runFixture(fixtureArgs(example), {
          labelRows: [
            { id: "label-id", name: "task" },
            { id: "review-id", name: "review" },
          ],
        });
        expect(model).toBeDefined();
      });
    }
  }
});
