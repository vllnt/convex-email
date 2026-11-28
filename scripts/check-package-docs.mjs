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
 * `raw.githubusercontent.com`). Group 1 or 2 is `owner/repo`, group 3 the file
 * path. Assumes a ref without `/` (such as `main` or `v1.2.3`); a link on a ref
 * like `refs/heads/main` or `feature/x` is not recognised as a shipped file.
 */
const GITHUB_FILE_URL =
  /^https:\/\/(?:github\.com\/([^/]+\/[^/]+)\/(?:blob|tree|raw)|raw\.githubusercontent\.com\/([^/]+\/[^/]+))\/[^/]+\/([^#?]+)/;

/** `owner/repo` in a GitHub repository URL. */
const GITHUB_REPOSITORY = /github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?\/?$/;

/**
 * A CommonMark fence opener: up to 3 spaces of indent, then 3+ backticks or 3+
 * tildes. Group 1 is the fence run, group 2 the info string.
 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** An inline code span on one line: a backtick run closed by a run of the same length. */
const INLINE_CODE = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g;

/**
 * Remove fenced code blocks and inline code spans, whose link syntax is only an
 * example. Per CommonMark, a fence opens only at the start of a line and closes
 * at a line holding only a fence of the same character that is at least as
 * long; an unclosed fence runs to the end of the file. Three backticks in the
 * middle of a line do not open a fence.
 *
 * @param {string} text - Markdown source.
 * @returns {string} The text with code removed.
 */
function stripCode(text) {
  const kept = [];
  let fence;
  for (const line of text.split("\n")) {
    if (fence !== undefined) {
      const close = FENCE_OPEN.exec(line);
      if (
        close !== null &&
        close[1][0] === fence[0] &&
        close[1].length >= fence.length &&
        close[2].trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open !== null && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = open[1];
      continue;
    }
    kept.push(line.replace(INLINE_CODE, ""));
  }
  return kept.join("\n");
}

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
 * Check every inline link in one shipped Markdown file against the packed files,
 * ignoring code. A relative link, resolved from the file's folder, must reach a
 * packed file. A GitHub file URL into this package's own repository must not
 * point at a packed file, because that copy follows a branch instead of the
 * installed version.
 *
 * @param {string} file - Packed path of the Markdown file.
 * @param {string} text - Contents of the file.
 * @param {Set<string>} packed - Paths in the tarball.
 * @param {string | undefined} repository - This package's `owner/repo`, if known.
 * @returns {string[]} One message per bad link.
 */
function checkLinks(file, text, packed, repository) {
  const problems = [];
  for (const [, target] of stripCode(text).matchAll(MARKDOWN_LINK)) {
    if (target.startsWith("#")) continue;
    const github = GITHUB_FILE_URL.exec(target);
    if (github !== null) {
      const owner = (github[1] ?? github[2]).toLowerCase();
      const shipped = posix.normalize(github[3]);
      const ownRepository = repository === undefined || owner === repository;
      if (ownRepository && packed.has(shipped)) {
        problems.push(
          `${file} link ${target} points at a shipped file; use a relative link to ${shipped}`,
        );
      }
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (target.startsWith("/")) {
      problems.push(
        `${file} link ${target} is an absolute path; use a relative link`,
      );
      continue;
    }
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
 * Read this package's `owner/repo` from `package.json` `repository`.
 *
 * @param {string} directory - Package directory containing `package.json`.
 * @returns {string | undefined} Lower-case `owner/repo`, or undefined when not on GitHub.
 */
function readRepository(directory) {
  /** @type {unknown} */
  const manifest = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const field = "repository" in manifest ? manifest.repository : undefined;
  const url =
    typeof field === "string"
      ? field
      : typeof field === "object" && field !== null && "url" in field
        ? field.url
        : undefined;
  if (typeof url !== "string") return undefined;
  return GITHUB_REPOSITORY.exec(url)?.[1].toLowerCase();
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
  const repository = readRepository(directory);
  for (const file of LINKED_FILES) {
    if (!packed.has(file)) continue;
    const text = readFileSync(join(directory, file), "utf8");
    problems.push(...checkLinks(file, text, packed, repository));
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
