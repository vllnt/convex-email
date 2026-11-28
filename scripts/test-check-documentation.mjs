import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import {
  checkDocumentation,
  ecosystem,
  footer,
  links,
} from "./check-documentation.mjs";

/**
 * Proves each rule of check-documentation.mjs: a complete fixture package
 * passes, and each broken copy fails with the rule's message. The fixture is
 * installed as `node_modules/@fixture/pkg` inside a throwaway consumer, so the
 * export probe resolves its types the way a real consumer does.
 */

const NAME = "@fixture/pkg";
const SHORT = "pkg";
const REPOSITORY = "https://github.com/example/pkg";
const DESCRIPTION = "TypeScript Convex component fixture for the documentation contract test.";
const PAGE = `https://oss.vllnt.com/packages/${SHORT}`;
const FENCE = "```";

/** @param {string[]} rows */
const lines = (rows) => `${rows.join("\n")}\n`;

const README_SECTIONS = {
  "For coding agents": "Read `docs/API.md` in the installed package first.",
  "When to use": lines([
    "- Use it when you test the documentation contract.",
    "- Use it when you need a fixture.",
    "- Do not use it when you ship code: use `@example/real`.",
  ]),
  Install: lines([`${FENCE}bash`, `pnpm add ${NAME}`, FENCE]),
  "Quick start": lines([
    `${FENCE}ts`,
    "// convex/run.ts",
    `import { Client } from "${NAME}";`,
    "",
    "new Client().run();",
    FENCE,
  ]),
  API: lines([
    "| Export | What it does |",
    "| --- | --- |",
    "| [`Client`](docs/API.md#client) | Client |",
    "| [`run()`](docs/API.md#run) | Run |",
    "| [`Options`](docs/API.md#options) | Options |",
  ]),
  "Common tasks": "See [Quick start](#quick-start).",
  "Errors and fixes": lines([
    "| Code | Message |",
    "| --- | --- |",
    "| `BAD_INPUT` | `input <name> must not be empty` |",
    "",
    "Plain errors: `fixture: broken`.",
  ]),
  "Limits and gotchas": "- None beyond the API reference.",
  Compatibility: "- Peer dependency: `convex`.",
  Testing: "Not applicable: the fixture has no tests.",
  Security: "Not applicable.",
  "Related packages": "None.",
  Contributing: "See the repository.",
  Links: links(SHORT, REPOSITORY),
  License: "MIT. See [LICENSE](LICENSE).",
};

/** @param {Record<string, string>} parts */
const readme = (parts) =>
  `# ${NAME}\n\n${DESCRIPTION}\n\n${Object.entries(parts)
    .map(([name, body]) => `## ${name}\n\n${body.trimEnd()}\n`)
    .join("\n")}\n${footer(SHORT)}`;

const LLMS = [
  `# ${NAME}`,
  "",
  `> ${DESCRIPTION}`,
  "",
  "## When to use",
  "",
  "- Use it when you test the contract.",
  "",
  "## Docs",
  "",
  "- [API](./docs/API.md)",
  "- [Errors](./README.md#errors-and-fixes)",
  "",
  ecosystem(SHORT),
].join("\n");

const API = lines([
  `# API Reference — ${NAME}`,
  "",
  "### `Client`",
  "",
  "### `run`",
  "",
  "### `Options`",
  "",
  "## Errors",
  "",
  "`BAD_INPUT`: `input <name> must not be empty`; plain `fixture: broken`.",
]);

const TYPES = lines([
  "/**",
  " * The fixture client.",
  ` * @see ${PAGE}`,
  " */",
  "export declare class Client {",
  "  /** Run it. */",
  "  run(): void;",
  "}",
  "/** Fixture options. */",
  "export interface Options {",
  "  a?: string;",
  "}",
]);

const SOURCE = lines([
  'import { ConvexError } from "convex/values";',
  "/** Throws. Example in a comment does not count: throw new Error(\"comment\"). */",
  "export function fail(name: string, broken: boolean): never {",
  '  if (broken) throw new Error("fixture: broken");',
  '  throw new ConvexError({ code: "BAD_INPUT", message: `input ${name} must not be empty` });',
  "}",
]);

/** The files of a fixture that passes, keyed by package-relative path. */
const complete = () => ({
  "package.json": JSON.stringify({
    name: NAME,
    version: "1.0.0",
    description: DESCRIPTION,
    keywords: ["a", "b", "c", "d", "e", "f", "g", "h"],
    repository: { type: "git", url: `${REPOSITORY}.git` },
    exports: {
      "./package.json": "./package.json",
      ".": { types: "./dist/index.d.ts" },
    },
  }),
  "README.md": readme(README_SECTIONS),
  "llms.txt": LLMS,
  "CHANGELOG.md": "# Changelog\n",
  LICENSE: "MIT\n",
  "docs/API.md": API,
  "dist/index.d.ts": TYPES,
  "src/fail.ts": SOURCE,
});

const workspace = mkdtempSync(join(tmpdir(), "check-documentation-"));
let failures = 0;
let counter = 0;

/**
 * Write a fixture package and check it.
 * @param {Record<string, string>} files
 * @returns {string | undefined} the failure message, or undefined when it passes
 */
function run(files) {
  counter += 1;
  const consumer = join(workspace, `case-${String(counter)}`);
  const installed = join(consumer, "node_modules", NAME);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(installed, path)), { recursive: true });
    writeFileSync(join(installed, path), text);
  }
  try {
    checkDocumentation(installed, consumer);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Assert one case.
 * @param {string} name
 * @param {Record<string, string>} files
 * @param {string} [fragment] text the failure must contain; omit for a pass
 */
function expect(name, files, fragment) {
  const message = run(files);
  const ok =
    fragment === undefined
      ? message === undefined
      : message !== undefined && message.includes(fragment);
  if (ok) {
    console.log(`OK    ${name}`);
    return;
  }
  failures += 1;
  console.error(
    `FAIL  ${name}: expected ${fragment === undefined ? "a pass" : `"${fragment}"`}, got ${message ?? "a pass"}`,
  );
}

/** @param {Record<string, string>} parts */
const withReadme = (parts) => ({ ...complete(), "README.md": readme(parts) });
/** @param {string} from @param {string} to @param {string} [file] */
const replace = (from, to, file = "README.md") => {
  const files = complete();
  const text = files[file];
  if (!text.includes(from)) throw new Error(`fixture lacks ${from}`);
  return { ...files, [file]: text.replace(from, to) };
};

try {
  expect("complete fixture passes", complete());

  const { "Common tasks": _tasks, ...missing } = README_SECTIONS;
  expect("missing section fails", withReadme(missing), "sections must be SECTIONS, in order");
  const { API: api, "Quick start": quick, ...rest } = README_SECTIONS;
  const swapped = {
    "For coding agents": rest["For coding agents"],
    "When to use": rest["When to use"],
    Install: rest.Install,
    API: api,
    "Quick start": quick,
    ...rest,
  };
  expect("sections out of order fail", withReadme(swapped), "sections must be SECTIONS, in order");
  expect(
    "empty section fails",
    withReadme({ ...README_SECTIONS, Security: "" }),
    "section Security is empty",
  );
  expect(
    "agent note over 3 lines fails",
    withReadme({ ...README_SECTIONS, "For coding agents": "a\nb\nc\nd" }),
    "3 lines at most",
  );
  expect(
    "intro of two sentences fails",
    replace(`${DESCRIPTION}\n\n## For`, `${DESCRIPTION} Second one.\n\n## For`),
    "title: one sentence",
  );
  expect(
    "intro that differs from package.json description fails",
    replace(DESCRIPTION, "TypeScript fixture with another sentence."),
    "README intro: package.json description",
  );
  expect(
    "When to use without a 'Do not use it' bullet fails",
    replace("- Do not use it when you ship code: use `@example/real`.\n", ""),
    "1 to 3 'Do not use it when'",
  );
  expect(
    "'Do not use it' without a named alternative fails",
    replace("you ship code: use `@example/real`.", "you ship code."),
    "names the better choice",
  );
  expect(
    "install below line 40 fails",
    withReadme({
      ...README_SECTIONS,
      "For coding agents": "x",
      "When to use": `${README_SECTIONS["When to use"]}${"Note.\n".repeat(40)}`,
    }),
    "install near the top",
  );
  expect(
    "badge above Quick start fails",
    withReadme({
      ...README_SECTIONS,
      Install: `${README_SECTIONS.Install}\n![npm version](https://img.shields.io/npm/v/x.svg)\n`,
    }),
    "badges go below Quick start",
  );
  expect(
    "code block without a language fails",
    replace("Not applicable: the fixture has no tests.", `${FENCE}\npnpm test\n${FENCE}`),
    "has no language",
  );
  expect(
    "untagged block in docs/API.md fails",
    replace("## Errors", `${FENCE}\nx\n${FENCE}\n\n## Errors`, "docs/API.md"),
    "docs/API.md:",
  );
  expect(
    "ts example with a ... gap fails",
    replace('new Client().run();', "new Client().run();\n// ..."),
    "has a ... gap",
  );
  expect(
    "ts example without a path comment fails",
    replace("// convex/run.ts\n", ""),
    "must start with a // <path>.ts comment",
  );
  expect(
    "broken relative link fails",
    replace("See [Quick start](#quick-start).", "See [x](./missing.md)."),
    "./missing.md does not resolve",
  );
  expect(
    "broken anchor fails",
    replace("See [Quick start](#quick-start).", "See [x](docs/API.md#nowhere)."),
    "has no such anchor",
  );
  expect(
    "link syntax inside code is ignored",
    replace("See [Quick start](#quick-start).", "See [Quick start](#quick-start) and `[x](./missing.md)`."),
  );
  expect(
    "export missing from the README API table fails",
    replace("| [`Options`](docs/API.md#options) | Options |\n", ""),
    "README API table lacks Options",
  );
  expect(
    "class method missing from the README API table fails",
    replace("| [`run()`](docs/API.md#run) | Run |\n", ""),
    "README API table lacks run",
  );
  expect(
    "export without a docs/API.md heading fails",
    {
      ...replace("### `Options`\n", "", "docs/API.md"),
      "README.md": readme({
        ...README_SECTIONS,
        API: README_SECTIONS.API.replace("[`Options`](docs/API.md#options)", "`Options`"),
      }),
    },
    "docs/API.md lacks a Options heading",
  );
  expect(
    "export without a TSDoc summary fails",
    replace("/** Fixture options. */\n", "", "dist/index.d.ts"),
    "Options has no TSDoc summary",
  );
  expect(
    "main entry without @see to the package page fails",
    replace(` * @see ${PAGE}\n`, "", "dist/index.d.ts"),
    `needs TSDoc @see ${PAGE}`,
  );
  expect(
    "error code missing from Errors and fixes fails",
    replace("| `BAD_INPUT` |", "| `OTHER` |"),
    "Errors and fixes lacks BAD_INPUT",
  );
  expect(
    "error code missing from docs/API.md fails",
    replace("`BAD_INPUT`:", "Code:", "docs/API.md"),
    "docs/API.md lacks BAD_INPUT",
  );
  expect(
    "thrown message missing from Errors and fixes fails",
    replace("`fixture: broken`", "`other`"),
    'Errors and fixes lacks the message "fixture: broken"',
  );
  expect(
    "templated message missing from docs/API.md fails",
    replace("`input <name> must not be empty`", "`input`", "docs/API.md"),
    'docs/API.md lacks the message "input … must not be empty"',
  );
  expect(
    "changed Links block fails",
    replace("- Sponsor: [GitHub Sponsors](https://github.com/sponsors/bntvllnt)", "- Sponsor: none"),
    "README Links: the shared block",
  );
  expect(
    "changed footer fails",
    replace("Built by [bntvllnt](https://bntvllnt.com)\n", "Built by someone\n"),
    "README ends with the vllnt footer",
  );
  expect(
    "llms.txt without the Ecosystem block at the end fails",
    replace("- [Author](https://bntvllnt.com)\n", "- [Author](https://bntvllnt.com)\n\nMore.\n", "llms.txt"),
    "llms.txt: ends with Ecosystem",
  );
  expect(
    "llms.txt without the errors link fails",
    replace("- [Errors](./README.md#errors-and-fixes)\n", "", "llms.txt"),
    "llms.txt: link the errors table",
  );
  expect(
    "retired vllnt domain in a shipped file fails",
    replace("# Changelog\n", `# Changelog\n\nSee ${["vllnt", "ai"].join(".")}.\n`, "CHANGELOG.md"),
    "mentions the retired vllnt domain",
  );
  expect(
    "description over 160 characters fails",
    replace(DESCRIPTION, `${DESCRIPTION}${" padding".repeat(20)}`, "package.json"),
    "description: 160 characters at most",
  );
  expect(
    "fewer than 8 keywords fails",
    replace('"g","h"]', '"g"]', "package.json"),
    "8 to 12 keywords",
  );
} finally {
  rmSync(workspace, { force: true, recursive: true });
}

if (failures > 0) {
  console.error(`FAILED ${String(failures)} test-check-documentation case(s)`);
  process.exitCode = 1;
} else {
  console.log("OK    test-check-documentation.mjs");
}
