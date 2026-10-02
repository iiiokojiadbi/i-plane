/** Bootstrap a pinned local tools archive before dependency installation. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = process.cwd();
const source = resolve(process.argv[2] ?? ".artifacts");
const pin = JSON.parse(await readFile(join(root, "accept-tools.json"), "utf8"));
if (pin.schema !== "for-plane/accept-tools-pin@1") throw new Error("Unsupported acceptance tools pin");
const target = join(root, ".artifacts");
await mkdir(target, { recursive: true });
const artifacts = [pin.tools, ...(pin.native ? [pin.native] : [])];
for (const artifact of artifacts) {
  if (!/^[a-zA-Z0-9._-]+$/.test(artifact.archive) || !/^[a-f0-9]{64}$/.test(artifact.sha256))
    throw new Error("Invalid pinned artifact name or checksum");
  const path = join(source, artifact.archive);
  if (
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex") !== artifact.sha256
  )
    throw new Error(`Pinned artifact checksum differs: ${artifact.archive}`);
}
const staging = await mkdtemp(join(target, ".install-"));
try {
  for (const artifact of artifacts) await cp(join(source, artifact.archive), join(staging, artifact.archive));
  const archive = join(staging, pin.tools.archive);
  const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 15_000 })
    .trim()
    .split("\n");
  if (names.some((path) => !path.startsWith("core/") || path.split("/").includes("..")))
    throw new Error("Tools archive has an invalid member path");
  execFileSync("tar", ["-xzf", archive, "-C", staging, "--no-same-owner"], { timeout: 15_000 });
  const identity = JSON.parse(await readFile(join(staging, "core/accept-tools.json"), "utf8"));
  if (identity.schema !== "for-plane/accept-tools@1" || identity.coreVersion !== pin.coreVersion)
    throw new Error("Tools archive core version differs from the product pin");
  await rm(join(target, "core"), { recursive: true, force: true });
  await rename(join(staging, "core"), join(target, "core"));
  for (const artifact of artifacts) await cp(join(staging, artifact.archive), join(target, artifact.archive));
  if (pin.native) {
    const native = join(target, "native");
    await mkdir(native, { recursive: true });
    await cp(join(staging, pin.native.archive), join(native, pin.native.archive));
    execFileSync("tar", ["-xzf", join(native, pin.native.archive), "-C", native, "--no-same-owner"], {
      timeout: 15_000,
    });
    const catalog = JSON.parse(await readFile(join(native, "package/catalog.json"), "utf8"));
    if (catalog.fingerprint !== pin.native.fingerprint)
      throw new Error("Native archive fingerprint differs from the pin");
    await writeFile(
      join(native, "artifact.json"),
      JSON.stringify({
        archive: pin.native.archive,
        fingerprint: pin.native.fingerprint,
        integrity: `sha512-${createHash("sha512")
          .update(await readFile(join(native, pin.native.archive)))
          .digest("base64")}`,
      }) + "\n",
    );
  }
  console.log(`Installed acceptance tools for core ${pin.coreVersion}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
