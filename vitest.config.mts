import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    exclude: ["**/node_modules/**", "dist/**"],
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    coverage: {
      provider: "v8",
      // List every source file that must be covered. Adding a source file here
      // without a matching test fails CI — that is the 100% E2E coverage gate.
      include: [
        "src/shared.ts",
        "src/client/index.ts",
        // The pure, injectable SMTP send + config logic — driven by a fake
        // transport, 100% covered with no network. The thin real-`nodemailer`
        // wrapper (`src/smtp/transport.ts`) is deliberately NOT listed: it is a
        // trivial pass-through to the Node-only library, consumer-E2E verified
        // (exactly as the `./react` live-backend path is the consuming app's E2E).
        "src/smtp/send.ts",
        // The generic-JMAP adapter. Pure end to end (an injected `fetch`, no
        // Node-only piece — JMAP is plain HTTP), so the WHOLE adapter is covered
        // here at 100% with a fake `fetch`; there is no excluded wrapper.
        "src/jmap/send.ts",
        "src/component/mutations.ts",
        "src/component/queries.ts",
        "src/component/validators.ts",
        "src/component/schema.ts",
        "src/component/crons.ts",
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
