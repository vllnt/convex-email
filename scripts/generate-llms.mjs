import { existsSync, readFileSync } from "node:fs";

// Keep the legacy command as a read-only check of the maintained discovery index.
const index = readFileSync("llms.txt", "utf8");
if (!index.startsWith("# @vllnt/convex-email\n")) {
  throw new Error("llms.txt must start with the package heading");
}
for (const [, target] of index.matchAll(/\]\(([^)]+)\)/g)) {
  if (/^(?:https?:|#)/.test(target)) continue;
  if (!existsSync(target.split("#")[0])) {
    throw new Error(`Missing llms.txt link target: ${target}`);
  }
}
console.log("Validated maintained llms.txt (no files generated)");
