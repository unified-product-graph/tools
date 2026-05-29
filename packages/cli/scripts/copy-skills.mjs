#!/usr/bin/env node
/**
 * copy-skills.mjs
 *
 * Copies the canonical skill markdown files from `@unified-product-graph/mcp-server` into the
 * `@unified-product-graph/cli` package so they ship in the CLI's npm tarball.
 *
 * Canonical source: `packages/upg-mcp-server/skills/`
 * Destination:      `packages/upg-cli/skills/`
 *
 * This script is:
 *   - Idempotent: the destination is wiped and re-created on every run.
 *   - Cross-platform: uses Node's fs APIs, no shell-specific tools.
 *   - Run during `prepack` and `build` so local dev and publish both stay in sync.
 *
 * Do NOT edit the copied files in `packages/upg-cli/skills/`; edit the
 * canonical source in `packages/upg-mcp-server/skills/` instead.
 */

import { cp, mkdir, rm, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const cliRoot = resolve(__dirname, "..");
const sourceDir = resolve(cliRoot, "..", "upg-mcp-server", "skills");
const destDir = resolve(cliRoot, "skills");

async function main() {
  if (!existsSync(sourceDir)) {
    console.error(
      `[copy-skills] ERROR: source directory not found: ${sourceDir}`,
    );
    console.error(
      "[copy-skills] Expected canonical skills at packages/upg-mcp-server/skills/",
    );
    process.exit(1);
  }

  const sourceStat = await stat(sourceDir);
  if (!sourceStat.isDirectory()) {
    console.error(`[copy-skills] ERROR: source is not a directory: ${sourceDir}`);
    process.exit(1);
  }

  // Wipe destination for a clean, idempotent copy.
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });

  // Recursive copy (Node 16.7+ supports fs.cp with recursive).
  await cp(sourceDir, destDir, { recursive: true });

  // Drop a README.md at the root of the copied folder so anyone who
  // inspects the unpacked tarball (or the folder during local dev)
  // knows not to edit here.
  const readmeBody = `# @unified-product-graph/cli bundled skills

This folder is **regenerated** from \`../upg-mcp-server/skills/\` every time
\`@unified-product-graph/cli\` is built or packed (via \`scripts/copy-skills.mjs\`).

Do **not** edit files here. Edit the canonical source in
\`packages/upg-mcp-server/skills/\` and re-run \`npm run build\` in
\`@unified-product-graph/cli\` to sync.

These skills are consumed by \`upg install-skills\`.
`;
  await writeFile(join(destDir, "README.md"), readmeBody, "utf8");

  const entries = await readdir(destDir);
  console.log(
    `[copy-skills] Copied ${entries.length} entries (incl. generated README.md) from ${sourceDir} → ${destDir}`,
  );
}

main().catch((err) => {
  console.error("[copy-skills] Failed:", err);
  process.exit(1);
});
