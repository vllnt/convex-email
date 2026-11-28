import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

/**
 * Import every runtime entry point from the packed tarball in a throwaway
 * consumer project, first without the optional `nodemailer` peer and then with
 * it. Without `nodemailer`, every entry except `./smtp` must load, and `./smtp`
 * must fail because `nodemailer` is missing. With it, `./smtp` must load and
 * export `createSmtpSender`. Run `pnpm build` first.
 *
 * Usage: node scripts/check-package-imports.mjs [package-dir]
 */

const SMTP_ENTRY = "./smtp";

/**
 * Read the installed version of a dev dependency, so the consumer uses the
 * versions this repository is tested with.
 *
 * @param {string} directory - Package directory.
 * @param {string} name - Dependency name.
 * @returns {string} The installed version.
 */
function installedVersion(directory, name) {
  const manifest = JSON.parse(
    readFileSync(join(directory, "node_modules", name, "package.json"), "utf8"),
  );
  return manifest.version;
}

/**
 * List the `exports` subpaths that have a runtime (`default`) target.
 *
 * @param {Record<string, unknown>} manifest - Parsed `package.json`.
 * @returns {string[]} Subpaths such as `.` and `./jmap`.
 */
function runtimeEntries(manifest) {
  return Object.entries(manifest.exports ?? {})
    .filter(
      ([, target]) =>
        typeof target === "object" && target !== null && "default" in target,
    )
    .map(([subpath]) => subpath);
}

/**
 * Import one entry point from inside the consumer project.
 *
 * @param {string} consumer - Consumer project directory.
 * @param {string} specifier - Full import specifier.
 * @param {string} [mustExport] - An export the module must have.
 * @returns {{ ok: boolean, code?: string, message?: string }} The import outcome.
 */
function tryImport(consumer, specifier, mustExport) {
  const script = `
    try {
      const module = await import(${JSON.stringify(specifier)});
      const name = ${JSON.stringify(mustExport ?? null)};
      if (name !== null && typeof module[name] !== "function") {
        console.log(JSON.stringify({ ok: false, message: "missing export " + name }));
      } else {
        console.log(JSON.stringify({ ok: true }));
      }
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
    }`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: consumer, encoding: "utf8" },
  );
  const line = result.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, message: `${result.stdout}${result.stderr}`.trim() };
  }
}

/**
 * Install packages into the consumer project with npm.
 *
 * @param {string} consumer - Consumer project directory.
 * @param {string[]} packages - Package specs or tarball paths.
 */
function npmInstall(consumer, packages) {
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...packages],
    { cwd: consumer, stdio: ["ignore", "ignore", "pipe"] },
  );
}

const directory = resolve(process.argv[2] ?? ".");
const manifest = JSON.parse(
  readFileSync(join(directory, "package.json"), "utf8"),
);
if (!existsSync(join(directory, "dist"))) {
  console.error("FAIL  dist/ is missing; run pnpm build first");
  process.exit(1);
}

const entries = runtimeEntries(manifest);
const workspace = mkdtempSync(join(tmpdir(), "check-package-imports-"));
let failures = 0;

/**
 * Record one check result.
 *
 * @param {string} name - What was checked.
 * @param {boolean} passed - Whether the check passed.
 * @param {string} [detail] - Output to show on failure.
 */
function report(name, passed, detail) {
  if (passed) {
    console.log(`OK    ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
}

try {
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", workspace],
    { cwd: directory, stdio: ["ignore", "ignore", "pipe"] },
  );
  const tarball = readdirSync(workspace).find((file) => file.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("npm pack produced no tarball");

  const consumer = join(workspace, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  npmInstall(consumer, [
    join(workspace, tarball),
    `convex@${installedVersion(directory, "convex")}`,
  ]);
  report(
    "nodemailer is not installed in the consumer",
    !existsSync(join(consumer, "node_modules", "nodemailer")),
  );

  for (const entry of entries) {
    const specifier = `${manifest.name}${entry.slice(1)}`;
    const result = tryImport(consumer, specifier);
    if (entry === SMTP_ENTRY) {
      report(
        `${specifier} fails without nodemailer`,
        !result.ok &&
          result.code === "ERR_MODULE_NOT_FOUND" &&
          /'nodemailer'/.test(result.message ?? ""),
        JSON.stringify(result),
      );
    } else {
      report(
        `${specifier} imports without nodemailer`,
        result.ok,
        result.message,
      );
    }
  }

  npmInstall(consumer, [
    `nodemailer@${installedVersion(directory, "nodemailer")}`,
  ]);
  const smtp = tryImport(
    consumer,
    `${manifest.name}${SMTP_ENTRY.slice(1)}`,
    "createSmtpSender",
  );
  report(
    `${manifest.name}/smtp imports with nodemailer and exports createSmtpSender`,
    smtp.ok,
    smtp.message,
  );
} finally {
  rmSync(workspace, { force: true, recursive: true });
}

if (failures > 0) {
  console.error(`FAILED ${failures} package import check(s)`);
  process.exitCode = 1;
} else {
  console.log(
    `OK    package imports: ${entries.length} runtime entry points checked`,
  );
}
