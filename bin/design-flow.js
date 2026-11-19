#!/usr/bin/env node
// Development entry: runs the compiled TypeScript in dist/. The published skill uses skills/design-flow/scripts/design-flow.mjs.
import { main } from "../dist/src/cli/cli.js";

process.exitCode = await main(process.argv.slice(2));
if (!["watch"].includes(process.argv[2] ?? "")) process.exit(process.exitCode);
