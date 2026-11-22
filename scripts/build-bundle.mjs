// Build the single-file bundle (dist/pg-lens.mjs) via the esbuild JS API.
//
// This replaces the old `npm run bundle` shell one-liner, which passed the
// banner through nested shell quoting:
//   --banner:js="import { createRequire } from \"node:module\"; ..."
// In some shells / clean-room environments those inner quotes were stripped,
// producing `import { createRequire } from node:module;` — a broken bundle.
// Passing the banner as a JS string here means no shell ever sees it.
import { build } from "esbuild";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "pg-lens.mjs");

await build({
  entryPoints: [join(root, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["pg-native"],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  outfile,
});

// Make the bundle directly executable so it can serve as the npm `bin`
// entry: prepend a shebang if esbuild did not emit one.
const contents = readFileSync(outfile, "utf8");
if (!contents.startsWith("#!")) {
  writeFileSync(outfile, `#!/usr/bin/env node\n${contents}`);
}
chmodSync(outfile, 0o755);

console.log(`Bundled ${outfile}`);
