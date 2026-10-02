import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../scripts/release.mjs", import.meta.url), "utf8");
const boundary = source.slice(source.indexOf('if (published !== "" && shouldPublish)'));

for (const published of ["", "2.1.1"]) {
  test(`release dry run accepts registry version ${published || "not published"}`, () => {
    const result = spawnSync("node", ["--input-type=module", "-e", `
      const published = ${JSON.stringify(published)};
      const shouldPublish = false;
      const reference = "i-plane@2.1.1";
      ${boundary}
    `], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry run: nothing was published");
  });
}

test("release publication still refuses an existing version", () => {
  const result = spawnSync("node", ["--input-type=module", "-e", `
    const published = "2.1.1";
    const shouldPublish = true;
    const reference = "i-plane@2.1.1";
    ${boundary}
  `], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("already in the registry; bump the version first");
  expect(result.stdout).not.toContain("publishing");
});
