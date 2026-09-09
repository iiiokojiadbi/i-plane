#!/usr/bin/env node
/*
 * Release gate.
 *
 * Publishing is irreversible: a version number cannot be reused, and a tarball
 * that shipped too much stays in the registry and in every mirror. So the
 * default is to do everything except publish — build, check, and print exactly
 * what would be uploaded, file by file. `--publish` is the only way to reach
 * `npm publish`.
 *
 *   node scripts/release.mjs              build, check, show the tarball
 *   node scripts/release.mjs --publish    the same, then upload
 *   node scripts/release.mjs --publish --otp 123456
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const shouldPublish = args.includes("--publish");
/*
 * An account with two-factor authentication on writes rejects a plain publish,
 * and the registry answers only after the tarball is prepared. The code is passed
 * per run rather than stored: it is valid for seconds by design.
 */
const otp = args.includes("--otp") ? args[args.indexOf("--otp") + 1] : undefined;

const run = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const reference = `${manifest.name}@${manifest.version}`;

console.log(`preparing ${reference}`);

console.log("\nchecking types...");
run("./node_modules/.bin/tsc", ["--noEmit"], { stdio: "inherit" });

console.log("checking lint and format...");
run("./node_modules/.bin/biome", ["check", "."], { stdio: "inherit" });

/*
 * Tests are part of the gate, not a habit. Every case in them is a bug that
 * shipped once; running them here is what stops the second time.
 */
console.log("running tests...");
run("bun", ["test"], { stdio: "inherit" });

/*
 * dist is emptied first. Everything under it is eligible for packaging, so a
 * file left from an experiment ships to the registry — where it stays, in every
 * mirror, for as long as the version exists.
 */
console.log("clearing dist...");
rmSync(join(root, "dist"), { recursive: true, force: true });

console.log("building...");
/*
 * undici stays external. Bundling it would pull 550 KB into a 29 KB tool and
 * quietly turn an optional dependency into a mandatory one — the import is
 * dynamic precisely so a plain network never loads it.
 */
run(
  "bun",
  [
    "build",
    "src/cli.ts",
    "--target=node",
    "--outfile=dist/cli.js",
    "--minify",
    "--external",
    "undici",
  ],
  { stdio: "inherit" },
);

/*
 * The built file is what users run. Checking it here rather than trusting the
 * bundler means a broken entry point cannot reach the registry: a package whose
 * command does not start is indistinguishable from a package that was never
 * installed.
 */
const entry = join(root, "dist", "cli.js");
if (!existsSync(entry)) throw new Error("dist/cli.js was not produced");
const built = readFileSync(entry, "utf8");
if (!built.startsWith("#!")) {
  throw new Error("dist/cli.js has no shebang; npm would install a file the shell cannot run");
}
console.log("smoke test: running the built command...");
const guide = run("node", [entry, "guide"]);
if (!guide.includes("HOW THIS TOOL BEHAVES")) {
  throw new Error("the built command did not print the guide");
}

console.log("\nwhat would be uploaded:");
const packed = JSON.parse(run("npm", ["pack", "--dry-run", "--json"]))[0] ?? {};
for (const file of packed.files ?? []) console.log(`  ${file.path}`);
console.log(`\nfiles: ${packed.files?.length ?? 0}`);
console.log(`unpacked: ${((packed.unpackedSize ?? 0) / 1024).toFixed(0)} KB`);
console.log(`tarball: ${((packed.size ?? 0) / 1024).toFixed(0)} KB`);

/*
 * Reporting the size is not the same as refusing a bad one. These bounds are the
 * shape of this package — three files, tens of kilobytes — so anything outside
 * them means something got in that nobody meant to publish.
 */
/*
 * AGENTS.md ships with the package: an agent that installs this tool can read
 * how it behaves without fetching the repository. CLAUDE.md is one line
 * importing it, so whichever name a tool looks for resolves to the same text.
 */
const EXPECTED_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "dist/cli.js",
  "package.json",
];
const MAX_TARBALL_KB = 200;
const shipped = (packed.files ?? []).map((file) => file.path).sort();
const unexpected = shipped.filter((path) => !EXPECTED_FILES.includes(path));
if (unexpected.length > 0) {
  throw new Error(`the package would ship files nobody declared: ${unexpected.join(", ")}`);
}
for (const required of EXPECTED_FILES) {
  if (!shipped.includes(required)) throw new Error(`${required} is missing from the package`);
}
if ((packed.size ?? 0) / 1024 > MAX_TARBALL_KB) {
  throw new Error(
    `tarball is ${((packed.size ?? 0) / 1024).toFixed(0)} KB, over the ${MAX_TARBALL_KB} KB bound`,
  );
}
console.log(`contents and size are within bounds`);

/*
 * A published version cannot be reused, so a collision has to stop the release
 * here rather than surface as a registry error the operator must interpret.
 */
let published = "";
try {
  published = run("npm", ["view", reference, "version"]).trim();
} catch (cause) {
  /*
   * `npm view` exits non-zero both for "no such version" and for "the registry
   * was unreachable". Treating every failure as the first one turns a network
   * problem into permission to publish over an existing version.
   */
  const text = String((cause && cause.stderr) || cause?.message || "");
  const missing = /E404|is not in this registry|404 Not Found/i.test(text);
  if (!missing) {
    throw new Error(
      `could not ask the registry whether ${reference} exists, so publishing is unsafe:\n${text.trim()}`,
    );
  }
}
if (published !== "") {
  throw new Error(`${reference} is already in the registry; bump the version first`);
}
console.log(`\n${reference} is not in the registry yet`);

if (!shouldPublish) {
  console.log("\ndry run: nothing was published. Pass --publish to upload exactly this.");
  process.exit(0);
}

console.log(`\npublishing ${reference}...`);
process.stdout.write(
  run("npm", ["publish", "--access", "public", ...(otp === undefined ? [] : ["--otp", otp])]),
);
console.log(`published ${reference}`);
