import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CHECKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "check-package-docs.mjs",
);

/** The files of a package that passes the check. */
const COMPLETE = {
  "README.md": "# fixture\n",
  LICENSE: "MIT\n",
  "CHANGELOG.md": "# Changelog\n",
  "docs/API.md": "# API\n",
  "llms.txt":
    "# fixture\n\n- [API](./docs/API.md)\n- [Changelog](./CHANGELOG.md)\n",
};

const workspace = mkdtempSync(join(tmpdir(), "check-package-docs-"));
let failures = 0;
let counter = 0;

/**
 * Write a fixture package and run the checker on it.
 *
 * @param {Record<string, string>} contents - Files to write, keyed by relative path.
 * @param {string[]} files - The `files` field of the fixture `package.json`.
 * @returns {{ status: number | null, output: string }} Exit status and combined output.
 */
function run(contents, files) {
  counter += 1;
  const directory = join(workspace, `case-${counter}`);
  mkdirSync(directory);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "fixture-pack",
      version: "1.0.0",
      files,
      repository: {
        type: "git",
        url: "git+https://github.com/example/fixture.git",
      },
    }),
  );
  for (const [path, text] of Object.entries(contents)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  const result = spawnSync(process.execPath, [CHECKER, directory], {
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Assert one case: expected exit status and, for failures, a message fragment.
 *
 * @param {string} name - Case name.
 * @param {{ status: number | null, output: string }} result - Checker result.
 * @param {number} status - Expected exit status.
 * @param {string} [fragment] - Text the output must contain.
 */
function expect(name, result, status, fragment) {
  const matches = fragment === undefined || result.output.includes(fragment);
  if (result.status === status && matches) {
    console.log(`OK    ${name}`);
    return;
  }
  failures += 1;
  console.error(
    `FAIL  ${name}: expected exit ${status}${fragment ? ` with "${fragment}"` : ""}, got exit ${result.status}\n${result.output}`,
  );
}

const allFiles = [
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "docs/API.md",
  "llms.txt",
];

try {
  expect("complete package passes", run(COMPLETE, allFiles), 0);

  expect(
    "llms.txt left out of files fails",
    run(
      COMPLETE,
      allFiles.filter((file) => file !== "llms.txt"),
    ),
    1,
    "required file missing from the tarball: llms.txt",
  );
  expect(
    "docs/API.md left out of files fails",
    run(
      COMPLETE,
      allFiles.filter((file) => file !== "docs/API.md"),
    ),
    1,
    "required file missing from the tarball: docs/API.md",
  );
  expect(
    "CHANGELOG.md left out of files fails",
    run(
      COMPLETE,
      allFiles.filter((file) => file !== "CHANGELOG.md"),
    ),
    1,
    "required file missing from the tarball: CHANGELOG.md",
  );
  expect(
    "relative llms.txt link to a file outside the tarball fails",
    run(
      {
        ...COMPLETE,
        "CONTRIBUTING.md": "# c\n",
        "llms.txt": "# f\n\n- [Contributing](./CONTRIBUTING.md)\n",
      },
      allFiles,
    ),
    1,
    "does not resolve to a file in the tarball",
  );
  expect(
    "GitHub URL to a shipped file fails",
    run(
      {
        ...COMPLETE,
        "llms.txt":
          "# f\n\n- [API](https://github.com/example/fixture/blob/main/docs/API.md)\n",
      },
      allFiles,
    ),
    1,
    "use a relative link to docs/API.md",
  );
  expect(
    "raw.githubusercontent.com URL to a shipped file fails",
    run(
      {
        ...COMPLETE,
        "llms.txt":
          "# f\n\n- [Changelog](https://raw.githubusercontent.com/example/fixture/main/CHANGELOG.md)\n",
      },
      allFiles,
    ),
    1,
    "use a relative link to CHANGELOG.md",
  );
  expect(
    "GitHub tree URL to a shipped file fails",
    run(
      {
        ...COMPLETE,
        "llms.txt":
          "# f\n\n- [API](https://github.com/example/fixture/tree/main/docs/API.md)\n",
      },
      allFiles,
    ),
    1,
    "use a relative link to docs/API.md",
  );
  expect(
    "broken relative link in README.md fails",
    run({ ...COMPLETE, "README.md": "# f\n\n[x](./missing.md)\n" }, allFiles),
    1,
    "README.md link ./missing.md does not resolve",
  );
  expect(
    "docs/API.md links resolve from docs/",
    run(
      {
        ...COMPLETE,
        "docs/API.md": "# API\n\n[Changelog](../CHANGELOG.md) [Top](#api)\n",
      },
      allFiles,
    ),
    0,
  );
  expect(
    "GitHub URL to the same path in another repository passes",
    run(
      {
        ...COMPLETE,
        "README.md":
          "# f\n\n[sibling](https://github.com/example/other/blob/main/docs/API.md)\n",
      },
      allFiles,
    ),
    0,
  );
  expect(
    "link syntax inside code passes",
    run(
      {
        ...COMPLETE,
        "README.md":
          "# f\n\n```md\n[example](./your-file.md)\n```\n\nInline `[x](./foo.md)` too.\n",
      },
      allFiles,
    ),
    0,
  );
  expect(
    "broken link after a mid-line triple backtick fails",
    run(
      {
        ...COMPLETE,
        "README.md":
          "# f\n\nWrap it in ```ts fences.\n\n[x](./missing.md)\n\n```\nend\n```\n",
      },
      allFiles,
    ),
    1,
    "README.md link ./missing.md does not resolve",
  );
  expect(
    "link syntax inside backtick, tilde, and longer fences passes",
    run(
      {
        ...COMPLETE,
        "README.md":
          "# f\n\n  ```md\n[a](./a.md)\n  ```\n\n~~~\n[b](./b.md)\n~~~\n\n````md\n```\n[c](./c.md)\n````\n",
      },
      allFiles,
    ),
    0,
  );
  expect(
    "broken link after a closed tilde fence fails",
    run(
      {
        ...COMPLETE,
        "README.md": "# f\n\n~~~\n```\n~~~\n\n[x](./missing.md)\n",
      },
      allFiles,
    ),
    1,
    "README.md link ./missing.md does not resolve",
  );
  expect(
    "absolute-path link fails",
    run(
      { ...COMPLETE, "llms.txt": "# f\n\n- [API](/docs/API.md)\n" },
      allFiles,
    ),
    1,
    "llms.txt link /docs/API.md is an absolute path",
  );
  const { LICENSE: _license, ...withoutLicense } = COMPLETE;
  expect(
    "missing LICENSE fails",
    run(withoutLicense, allFiles),
    1,
    "required file missing from the tarball: LICENSE",
  );
  expect(
    "GitHub URL to a file outside the tarball passes",
    run(
      {
        ...COMPLETE,
        "llms.txt":
          "# f\n\n- [Contributing](https://github.com/example/fixture/blob/main/CONTRIBUTING.md)\n- [Home](https://oss.vllnt.com/llms.txt)\n",
      },
      allFiles,
    ),
    0,
  );
} finally {
  rmSync(workspace, { force: true, recursive: true });
}

if (failures > 0) {
  console.error(`FAILED ${failures} test-check-package-docs case(s)`);
  process.exitCode = 1;
} else {
  console.log("OK    test-check-package-docs.mjs");
}
