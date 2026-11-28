import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  checkDocumentation,
  checkRetiredDomain,
  convexHost,
  writeHost,
} from "./check-documentation.mjs";

/**
 * Pack the built package, install it in a throwaway consumer project with the
 * lowest supported convex, check the docs contract on what was installed, then
 * type-check every README `ts` example against the installed `dist` and run the
 * README's own test. Run `pnpm build` first.
 *
 * Usage: node scripts/test-package.mjs [package-dir]
 */

const root = resolve(process.argv[2] ?? ".");
/** @type {{ name: string, peerDependencies: Record<string, string> }} */
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!existsSync(join(root, "dist"))) {
  console.error("FAIL  dist/ is missing; run pnpm build first");
  process.exit(1);
}

/** @param {string} name a dev dependency installed in this repository */
const installed = (name) =>
  JSON.parse(
    readFileSync(join(root, "node_modules", name, "package.json"), "utf8"),
  ).version;

/** The lowest convex the peer range allows, such as 1.45.0 for ^1.45.0. */
const convexFloor = /\d+\.\d+\.\d+/u.exec(metadata.peerDependencies.convex)?.[0];
if (convexFloor === undefined) throw new Error("cannot read the convex peer range");

// No other @vllnt docs domain is allowed anywhere in the repository.
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter((file) => file !== "" && existsSync(join(root, file)));
checkRetiredDomain(
  Object.fromEntries(
    tracked.map((file) => [file, readFileSync(join(root, file), "utf8")]),
  ),
);

const temporary = mkdtempSync(join(tmpdir(), "convex-email-consumer-"));
/** @param {string} command @param {string[]} arguments_ @param {string} [cwd] */
const run = (command, arguments_, cwd = temporary) =>
  execFileSync(command, arguments_, { cwd, stdio: "inherit" });
/** @param {string[]} files @param {string} module @param {string} types */
const compile = (files, module, types) =>
  run("npx", [
    "--no-install",
    "tsc",
    "--noEmit",
    "--strict",
    "--module",
    module,
    "--moduleResolution",
    module === "NodeNext" ? "NodeNext" : "Bundler",
    "--target",
    "ES2022",
    "--types",
    types,
    ...files,
  ]);

try {
  run("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", temporary], root);
  const tarball = readdirSync(temporary).find((file) => file.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("npm pack produced no tarball");
  writeFileSync(
    join(temporary, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(temporary, tarball),
    `convex@${convexFloor}`,
    // The newest convex-test whose convex peer range still allows the convex floor.
    "convex-test@0.0.71",
    `vitest@${installed("vitest")}`,
    `vite@${installed("vite")}`,
    `@edge-runtime/vm@${installed("@edge-runtime/vm")}`,
    `nodemailer@${installed("nodemailer")}`,
    "typescript@5.9.3",
    "@types/node@22.20.2",
  ]);

  // Docs contract on the installed package, then the README examples in a stub host.
  const packageDirectory = join(temporary, "node_modules", metadata.name);
  const examples = checkDocumentation(packageDirectory, temporary);
  console.log(`OK    docs contract (${String(examples.length)} README ts examples)`);
  const hostFiles = writeHost(
    temporary,
    convexHost(packageDirectory, examples),
    examples,
  );
  compile(hostFiles, "ESNext", "vite/client,node");
  console.log("OK    README examples type-check against the installed dist");
  // The README's own vitest.config.mts runs its test example.
  run("npx", ["--no-install", "vitest", "run"]);

  // Every typed entry point resolves for a NodeNext consumer too.
  writeFileSync(
    join(temporary, "consumer.ts"),
    `
import { Email } from "${metadata.name}";
import type { ComponentApi } from "${metadata.name}/_generated/component.js";
import type { ComponentApi as BareComponentApi } from "${metadata.name}/_generated/component";
import config from "${metadata.name}/convex.config.js";
import bareConfig from "${metadata.name}/convex.config";
import { createJmapSender } from "${metadata.name}/jmap";
import { createSmtpSender } from "${metadata.name}/smtp";
import { defineApp } from "convex/server";
declare const component: ComponentApi;
const client = new Email(component);
const app = defineApp(); app.use(config); app.use(bareConfig, { name: "bare" });
const bare: BareComponentApi = component;
void client; void bare; void createJmapSender; void createSmtpSender;
`,
  );
  compile(["consumer.ts"], "NodeNext", "node");
  // The shipped test helper is TypeScript source: it must compile for both resolutions.
  writeFileSync(
    join(temporary, "registration.ts"),
    `
import { register } from "${metadata.name}/test";
import { convexTest } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
const host = defineSchema({ unrelated: defineTable({ label: v.string() }) });
register(convexTest(host, {}), "custom");
`,
  );
  compile(["registration.ts"], "ESNext", "vite/client,node");
  compile(["registration.ts"], "NodeNext", "node");
  console.log("OK    package test: docs contract, README examples, typed entry points");
} finally {
  rmSync(temporary, { force: true, recursive: true });
}
