// Build the self-contained skill: skills/design-flow/{SKILL.md, scripts/design-flow.mjs, scripts/web/, schema/}.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "skills", "design-flow");
rmSync(join(out, "scripts"), { recursive: true, force: true });
rmSync(join(out, "schema"), { recursive: true, force: true });
mkdirSync(join(out, "scripts"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "cli", "entry.ts")],
  outfile: join(out, "scripts", "design-flow.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  define: { __DESIGN_FLOW_BUNDLE__: "true" },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  external: ["bufferutil", "utf-8-validate"],
});
cpSync(join(root, "dist", "web"), join(out, "scripts", "web"), { recursive: true });
cpSync(join(root, "schema"), join(out, "schema"), { recursive: true });
console.log(`skill bundled into ${out}`);
