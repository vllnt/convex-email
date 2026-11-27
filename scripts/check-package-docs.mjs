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

/**
 * A GitHub URL to one file on a branch or tag (`/blob/`, `/tree/`, `/raw/`, or
 * `raw.githubusercontent.com`). Group 1 is the repository path of the file.
 */
const GITHUB_FILE_URL =
  /^https:\/\/(?:github\.com\/[^/]+\/[^/]+\/(?:blob|tree|raw)|raw\.githubusercontent\.com\/[^/]+\/[^/]+)\/[^/]+\/([^#?]+)/;

/** Shipped Markdown files whose links must resolve inside the tarball. */
const LINKED_FILES = ["llms.txt", "README.md", "docs/API.md"];

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
 * Check every link in one shipped Markdown file against the packed files. A
 * relative link, resolved from the file's folder, must reach a packed file. A
 * GitHub file URL must not point at a packed file, because that copy follows a
 * branch instead of the installed version.
 *
 * @param {string} file - Packed path of the Markdown file.
 * @param {string} text - Contents of the file.
 * @param {Set<string>} packed - Paths in the tarball.
 * @returns {string[]} One message per bad link.
 */
function checkLinks(file, text, packed) {
  const problems = [];
  for (const [, target] of text.matchAll(MARKDOWN_LINK)) {
    if (target.startsWith("#")) continue;
    const github = GITHUB_FILE_URL.exec(target);
    if (github !== null) {
      const shipped = posix.normalize(github[1]);
      if (packed.has(shipped)) {
        problems.push(
          `${file} link ${target} points at a shipped file; use a relative link to ${shipped}`,
        );
      }
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const path = posix.join(posix.dirname(file), target.split("#")[0]);
    if (!packed.has(path)) {
      problems.push(
        `${file} link ${target} does not resolve to a file in the tarball`,
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
  for (const file of LINKED_FILES) {
    if (!packed.has(file)) continue;
    const text = readFileSync(join(directory, file), "utf8");
    problems.push(...checkLinks(file, text, packed));
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
    `OK    package docs: ${REQUIRED_FILES.length} required files in a ${packed}-file tarball, doc links resolve`,
  );
}
