/**
 * Build the Chrome Web Store upload artifact.
 *
 * Produces `artifacts/sherpa-<version>.zip` from `dist/`, after re-running the
 * same checks CI does — a package that fails verify-bundle would install and
 * then be unable to embed anything, which is exactly the sort of thing that
 * survives review and breaks for users.
 *
 * The store wants the manifest at the *root* of the zip, not inside a folder.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const outDir = join(root, "artifacts");

/** Never ship these, even if a build leaves them behind. */
const EXCLUDE = [".DS_Store", "*.map"];

/** Chrome Web Store's hard ceiling for a package. */
const MAX_PACKAGE_BYTES = 2 * 1024 ** 3;
/** Ours is unusually large because the model ships offline; warn past this. */
const LARGE_PACKAGE_BYTES = 100 * 1024 ** 2;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

const manifestPath = join(dist, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")).valueOf();
const { version, name } = manifest;

// The store rejects a listing whose description exceeds the summary limit.
if ((manifest.description ?? "").length > 132) {
  throw new Error(
    `manifest description is ${manifest.description.length} chars; the store allows 132`,
  );
}

await mkdir(outDir, { recursive: true });
const zipPath = join(outDir, `sherpa-${version}.zip`);
await rm(zipPath, { force: true });

// `zip -r . ` from inside dist so paths are root-relative in the archive.
await run("zip", ["-r", "-q", "-X", zipPath, ".", "-x", ...EXCLUDE], { cwd: dist });

const { size } = await stat(zipPath);
const files = await walk(dist);
const biggest = (
  await Promise.all(
    files.map(async (f) => ({ path: relative(dist, f), bytes: (await stat(f)).size })),
  )
)
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 5);

const mb = (n) => `${(n / 1024 ** 2).toFixed(1)} MB`;

console.log(`\npackage: ${name} ${version}`);
console.log(`  → ${relative(root, zipPath)}  (${mb(size)} zipped, ${files.length} files)`);
console.log("\n  largest entries:");
for (const f of biggest) console.log(`    ${mb(f.bytes).padStart(9)}  ${f.path.split(sep).join("/")}`);

if (size > MAX_PACKAGE_BYTES) {
  console.error(`\npackage: FAILED — ${mb(size)} exceeds the store limit of ${mb(MAX_PACKAGE_BYTES)}`);
  process.exit(1);
}
if (size > LARGE_PACKAGE_BYTES) {
  console.warn(
    `\npackage: note — ${mb(size)} is a large package. It's the bundled embedding models, which is` +
      "\n  the deliberate trade for zero-egress (PRD 5.10.1). Expect a slower review.",
  );
}
console.log("\npackage: ready to upload at https://chrome.google.com/webstore/devconsole\n");
