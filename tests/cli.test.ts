import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { ALL_COMMANDS, GLOBAL_OPTIONS } from "../src/registry.ts";

const run = (...args: string[]) =>
  spawnSync(process.execPath, ["src/cli.ts", ...args], { encoding: "utf8", timeout: 5000 });

for (const command of ALL_COMMANDS) {
  test(`CLI accepts every declared flag for ${command.name}`, () => {
    const flags = (command.options ?? []).flatMap((option) => [
      option.flag,
      ...(option.value === undefined ? [] : ["value"]),
    ]);
    const result = run(...command.name.split(" "), ...flags, "--help", "--json");
    expect(result.status).toBe(0);
    const model = JSON.parse(result.stdout);
    expect(model.globalOptions).toEqual(GLOBAL_OPTIONS);
    if (command.name === "guide") expect(model.groups).toBeDefined();
    else expect(model.command.name).toBe(command.name);
  });
}
for (const argv of [
  ["project"],
  ["project", "typo"],
  ["label", "create", "task", "--colour", "red"],
  ["guide", "--typo"],
  ["--typo"],
]) {
  test(`bad invocation exits 2: ${argv.join(" ")}`, () => {
    expect(run(...argv, "--config", "/dev/null").status).toBe(2);
  });
}
for (const family of ["project", "label", "state", "cycle", "module", "intake"]) {
  test(`${family} --help lists its children`, () => {
    const result = run(family, "--help", "--json");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).globalOptions).toEqual(GLOBAL_OPTIONS);
    expect(
      JSON.parse(result.stdout).commands.every((command: { name: string }) =>
        command.name.startsWith(`${family} `),
      ),
    ).toBe(true);
  });
}
