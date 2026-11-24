#!/usr/bin/env node
// Development entry: runs the compiled TypeScript in dist/. The published skill uses skills/design-flow/scripts/design-flow.mjs.
import { main } from "../dist/src/cli/cli.js";

// Every command ends here, watch included (it returns on SIGTERM or SIGINT).
process.exit(await main(process.argv.slice(2)));
