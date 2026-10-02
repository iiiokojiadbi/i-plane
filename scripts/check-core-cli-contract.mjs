/** Compare standalone CLI fixtures with the verified installed core version. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cli = resolve(import.meta.dirname, "..");
const core = resolve(fileURLToPath(import.meta.resolve("for-plane/sdk/protocol.mts")), "../..");
const installedVersion = process.env.FOR_PLANE_ACCEPT_CORE_VERSION;
assert(installedVersion, "Run through npm run accept to verify the installed core receipt");
const contract = JSON.parse(await readFile(join(core, "checks/core-http.json"), "utf8"));
assert.equal(contract.coreVersion, installedVersion, `Pinned HTTP schema differs from installed core ${installedVersion}`);
const { canonical } = await import(join(core, "scripts/contracts/core-surface.mjs"));
function differingField(left, right, path = "$") {
  if (JSON.stringify(left) === JSON.stringify(right)) return undefined;
  if (left && right && typeof left === "object" && typeof right === "object") {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const mismatch = differingField(left[key], right[key], `${path}.${key}`);
      if (mismatch) return mismatch;
    }
  }
  return path;
}
const copy = JSON.parse(
  await readFile(resolve(cli, `tests/fixtures/core/http-${contract.coreVersion}.json`), "utf8"),
);
const assertion = "CLI response fixture differs from the published core HTTP contract";
const compare = (value, mutation = false) => {
  const field = differingField(canonical(value), canonical(copy));
  assert(!field, mutation ? assertion : `${assertion}: core ${installedVersion}, field ${field}`);
};
compare(contract);
assert.equal(
  await readFile(resolve(core, "scripts/contracts/http-shape.mjs"), "utf8"),
  await readFile(resolve(cli, "tests/helpers/core-http-shape.mjs"), "utf8"),
  `CLI wire-schema validator copy differs from core ${installedVersion}: validator source`,
);
if (process.argv[2] === "mutation") {
  const changed = structuredClone(contract);
  const schema = changed.routes["GET /api/extensions/node-readers/"].success;
  assert(
    schema.required.includes("fingerprint") && schema.properties.fingerprint,
    "Reader shape mutation anchor is absent",
  );
  schema.properties.readerDigest = schema.properties.fingerprint;
  delete schema.properties.fingerprint;
  schema.required = schema.required.map((name) => (name === "fingerprint" ? "readerDigest" : name));
  // Exercise the standalone consumer against the changed published vocabulary.
  // A stale-copy comparison alone would not prove its actual response fixtures.
  const temporary = await mkdtemp(join(tmpdir(), "core-cli-wire-mutation-"));
  try {
    await mkdir(join(temporary, "tests/helpers"), { recursive: true });
    await mkdir(join(temporary, "tests/fixtures/core"), { recursive: true });
    for (const name of ["core-http.ts", "core-http-shape.mjs"])
      await cp(join(cli, "tests/helpers", name), join(temporary, "tests/helpers", name));
    await cp(
      join(cli, "tests/core-http-contract.test.ts"),
      join(temporary, "tests/core-http-contract.test.ts"),
    );
    await cp(join(cli, "tests/fixtures/pages"), join(temporary, "tests/fixtures/pages"), { recursive: true });
    const vocabulary = join(temporary, `tests/fixtures/core/http-${contract.coreVersion}.json`);
    const run = () =>
      spawnSync("bun", ["test", "tests/core-http-contract.test.ts"], {
        cwd: temporary,
        encoding: "utf8",
        timeout: 10000,
      });
    await writeFile(vocabulary, JSON.stringify(contract));
    const positive = run();
    if (positive.error || positive.status !== 0)
      throw new Error(`CLI mutation positive control failed: ${positive.error ?? positive.stderr}`);
    await writeFile(vocabulary, JSON.stringify(changed));
    const negative = run();
    if (negative.error || negative.status !== 1 || !negative.stderr.includes("readerDigest"))
      throw new Error(`CLI mutation missed the response field: ${negative.error ?? negative.stderr}`);
    console.log("Standalone CLI fixtures rejected the mutated readerDigest field");
    compare(changed, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else {
  assert(process.argv[2] === undefined, "Unknown CLI contract mode");
  const child = spawnSync(
    "bun",
    [
      "test",
      "tests/core-http-contract.test.ts",
      "tests/wiki-commands.test.ts",
      "tests/page-node-readers.test.ts",
      "tests/page-node-discovery.test.ts",
      "tests/page-transport.test.ts",
      "tests/page-api-key.test.ts",
      "tests/page-commands.test.ts",
    ],
    { cwd: cli, encoding: "utf8", timeout: 30000 },
  );
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  if (child.error) throw child.error;
  assert.equal(child.status, 0, "CLI tests reject the current versioned core response fixtures");
  console.log(JSON.stringify({ passed: true, coreVersion: contract.coreVersion, standaloneCli: true }));
}
