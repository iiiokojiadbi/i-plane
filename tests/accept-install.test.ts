import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

test("ordinary CLI dependencies and lockfile need no local core or native artifacts", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(manifest[group] ?? {})) {
      expect(name).not.toBe("for-plane");
      expect(name).not.toBe("@for-plane/native-types");
      expect(String(version)).not.toMatch(/^(file:|link:)/);
    }
  }
  expect(readFileSync(join(root, "package-lock.json"), "utf8")).not.toContain(".artifacts");
  expect(JSON.parse(readFileSync(join(root, "accept-tools.json"), "utf8")).native).toBeUndefined();
});

test("acceptance explains missing tools and forwards arguments to the opt-in tools", () => {
  const checkout = mkdtempSync(join(tmpdir(), "cli-accept-"));
  try {
    mkdirSync(join(checkout, "scripts"));
    copyFileSync(join(root, "scripts/accept.mjs"), join(checkout, "scripts/accept.mjs"));
    const run = () => spawnSync("node", ["scripts/accept.mjs", "--affected"], {
      cwd: checkout, encoding: "utf8",
    });
    const missing = run();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("npm run accept:install -- /path/to/artifacts");
    mkdirSync(join(checkout, ".artifacts/core/scripts/accept"), { recursive: true });
    writeFileSync(join(checkout, ".artifacts/core/scripts/accept/main.mts"),
      'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;\n');
    const installed = run();
    expect(installed.status).toBe(7);
    expect(JSON.parse(installed.stdout)).toEqual(["--affected"]);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
