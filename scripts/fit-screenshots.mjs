/**
 * Fit real screenshots to the Chrome Web Store's exact dimensions.
 *
 * The store accepts 1280×800 or 640×400 and nothing else, while a macOS window
 * capture is whatever size the window happened to be. This pads captures onto a
 * canvas of the right size in the product's own paper colour — it never
 * stretches or crops, so the pixels stay exactly what was on screen.
 *
 * Put captures of the *running* extension in store/screenshots/raw/ and run
 * `npm run shots:fit`. This script deliberately cannot invent a screenshot:
 * store screenshots must show real functionality, and a headless render would
 * show mocked content instead of a real index.
 *
 * Output lands in store/screenshots/ — the folder you upload from. Preview
 * renders of the design mockups live one level down in store/screenshots/preview/
 * (`npm run capture:screenshots`) and are for planning the listing only.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawDir = join(root, "store", "screenshots", "raw");
const outDir = join(root, "store", "screenshots");

/** The larger of the two accepted sizes; use it unless you have a reason not to. */
const TARGET = { width: 1280, height: 800 };
/** --paper from src/ui/styles.css, so padding reads as part of the design. */
const PAD_COLOUR = "FBF9F5";

if (process.platform !== "darwin") {
  console.error(
    "fit-screenshots: this uses macOS `sips`.\n" +
      `  Elsewhere, pad each capture onto a ${TARGET.width}×${TARGET.height} canvas (#${PAD_COLOUR})\n` +
      "  with any image editor — do not stretch or crop.",
  );
  process.exit(1);
}

await mkdir(rawDir, { recursive: true });

const captures = (await readdir(rawDir)).filter((f) => /\.(png|jpe?g)$/i.test(f));

if (captures.length === 0) {
  console.log(
    `fit-screenshots: nothing in ${join("store", "screenshots", "raw")}.\n\n` +
      "  Capture these from the extension you have loaded, with a real index:\n" +
      "    1. Side panel showing an answer with its citations and source cards\n" +
      "    2. Crawl setup showing the scope estimate (pages / duration / disk)\n" +
      "    3. The index list\n" +
      "    4. The content gap report\n\n" +
      "  On macOS, ⌘⇧4 then Space captures a single window cleanly.\n" +
      "  Drop the PNGs in that folder and re-run.",
  );
  process.exit(0);
}

for (const file of captures) {
  const src = join(rawDir, file);
  const name = `${basename(file, extname(file))}-${TARGET.width}x${TARGET.height}.png`;
  const dest = join(outDir, name);

  // Two steps: shrink to fit inside the target (never enlarge past it), then
  // pad out to the exact canvas. `-Z` preserves aspect ratio.
  await run("sips", [
    "-s", "format", "png",
    "-Z", String(Math.max(TARGET.width, TARGET.height)),
    src,
    "--out", dest,
  ]);
  await run("sips", [
    "--padToHeightWidth", String(TARGET.height), String(TARGET.width),
    "--padColor", PAD_COLOUR,
    dest,
  ]);

  const { size } = await stat(dest);
  console.log(`fit-screenshots: ${name}  ${(size / 1024).toFixed(0)} KB`);
}

console.log(
  `\nfit-screenshots: ${captures.length} ready in store/screenshots/ at ${TARGET.width}×${TARGET.height}.`,
);
