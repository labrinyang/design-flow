import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, startServer } from "./server.ts";

declare const __DESIGN_FLOW_BUNDLE__: boolean | undefined;

const home = process.env.DESIGN_FLOW_HOME ?? join(homedir(), ".design-flow");
mkdirSync(home, { recursive: true });
const log = (m: string) => appendFileSync(join(home, "server.log"), `${new Date().toISOString()} ${m}\n`);
const port = process.env.DESIGN_FLOW_PORT !== undefined ? Number(process.env.DESIGN_FLOW_PORT) : DEFAULT_PORT;
const here = dirname(fileURLToPath(import.meta.url));
// Bundled skill: scripts/web next to scripts/design-flow.mjs. Dev build: dist/web.
const webRoot = [join(here, "web"), join(here, "..", "..", "web")].find((d) => existsSync(join(d, "index.html")));
const locale = (process.env.DESIGN_FLOW_LOCALE ?? Intl.DateTimeFormat().resolvedOptions().locale).startsWith("zh") ? "zh" : "en";

export function runServer(): Promise<void> {
  return startServer({ port, home, webRoot, locale }).then(
  (s) => {
    log(`listening on ${s.port}${webRoot ? "" : " (no web build found)"}`);
    const stop = () => s.close().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  },
  (e: Error) => {
    log(`failed: ${e.stack}`);
    process.exit(1);
  },
);
}

// Dev build: `node dist/src/server/main.js` starts the server. Not in the bundled skill, where every module shares the
// launcher's import.meta.url and this would start a server inside every command; there entry.ts starts it for `__serve`.
if (typeof __DESIGN_FLOW_BUNDLE__ === "undefined" && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void runServer();
