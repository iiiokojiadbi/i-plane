/** Acceptance tools are installed only by the explicit opt-in command. */
import { existsSync } from "node:fs";

const entry = new URL("../.artifacts/core/scripts/accept/main.mts", import.meta.url);
if (!existsSync(entry)) {
  console.error("Acceptance tools are not installed. Run npm run accept:install -- /path/to/artifacts.");
  process.exit(1);
}
await import(entry.href);
