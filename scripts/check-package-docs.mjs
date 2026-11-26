import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import process from "node:process";

/**
 * Files the npm tarball must contain so coding agents can read documentation that
 * matches the installed version from `node_modules/@vllnt/convex-email/`.
 */
const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "llms.txt",
  "docs/API.md",
];

/** A GitHub blob URL on any ref: group 1 is the repository path of the file. */
const GITHUB_BLOB_URL =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/;

/** A Markdown link target: `](target)`. */
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;

/**
 * List the paths `npm pack` would put in the tarball for a package directory.
 *
 * @param {string} directory - Package directory containing `package.json`.
 * @returns {Set<string>} Packed paths relative to the package root, with `/` separators.
 */
function listPackedFiles(directory) {
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  /** @type {unknown} */
  const report = JSON.parse(output);
  const entry = Array.isArray(report) ? report[0] : undefined;
  if (
    typeof entry !== "object" ||
    entry === null ||
    !Array.isArray(entry.files)
  ) {
    throw new Error("npm pack --dry-run --json returned no file list");
  }
  const paths = new Set();
  for (const file of entry.files) {
    if (
      typeof file === "object" &&
      file !== null &&
      typeof file.path === "string"
    ) {
      paths.add(file.path);
    }
  }
  return paths;
}

/**
 * Check every link in `llms.txt` against the packed files. A relative link must
 * resolve to a packed file. A GitHub blob URL must not point at a packed file,
 * because that copy follows a branch instead of the installed version.
 *
 * @param {string} index - Contents of `llms.txt`.
 * @param {Set<string>} packed - Paths in the tarball.
 * @returns {string[]} One message per bad link.
 */
function checkLlmsLinks(index, packed) {
  const problems = [];
  for (const [, target] of index.matchAll(MARKDOWN_LINK)) {
    if (target.startsWith("#")) continue;
    const blob = GITHUB_BLOB_URL.exec(target);
    if (blob !== null) {
      if (packed.has(posix.normalize(blob[1]))) {
        problems.push(
          `llms.txt link ${target} points at a shipped file; use ./${blob[1]}`,
        );
      }
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const path = posix.normalize(target.split("#")[0]);
    if (!packed.has(path)) {
      problems.push(
        `llms.txt link ${target} does not resolve to a file in the tarball`,
      );
    }
  }
  return problems;
}

/**
 * Check one package directory and return its problems.
 *
 * @param {string} directory - Package directory containing `package.json`.
 * @returns {{ problems: string[], packed: number }} Problems found and tarball size.
 */
function checkPackage(directory) {
  const packed = listPackedFiles(directory);
  const problems = [];
  for (const required of REQUIRED_FILES) {
    if (!packed.has(required)) {
      problems.push(`required file missing from the tarball: ${required}`);
    }
  }
  if (packed.has("llms.txt")) {
    const index = readFileSync(join(directory, "llms.txt"), "utf8");
    problems.push(...checkLlmsLinks(index, packed));
  }
  return { problems, packed: packed.size };
}

const directory = resolve(process.argv[2] ?? ".");
const { problems, packed } = checkPackage(directory);
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  process.exitCode = 1;
} else {
  console.log(
    `OK    package docs: ${REQUIRED_FILES.length} required files in a ${packed}-file tarball, llms.txt links resolve`,
  );
}
