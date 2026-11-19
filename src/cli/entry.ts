import { main } from "./cli.ts";
import { runServer } from "../server/main.ts";

// One file for everything: `design-flow __serve` starts the server (spawned detached by `open`).
if (process.argv[2] === "__serve") await runServer();
else {
  process.exitCode = await main(process.argv.slice(2));
  if (process.argv[2] !== "watch") process.exit(process.exitCode);
}
