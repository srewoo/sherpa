/**
 * Rasterise the store's marketing artwork and regenerate the extension icons
 * from `public/icons/icon.svg`.
 *
 * Scope note: this renders *artwork* — promo tiles and icons. It deliberately
 * does not produce screenshots. Chrome Web Store screenshots must show the real
 * running extension, and anything rendered here would show mocked content rather
 * than a real index. `npm run capture:screenshots` renders the design mockups as
 * clearly-labelled previews for planning the listing; `npm run shots:fit` sizes
 * the real captures you actually upload.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "store", "assets");
const icons = join(root, "public", "icons");

/** Store artwork, at the exact dimensions the dashboard requires. */
const TILES = [
  { svg: "promo-small.svg", png: "promo-small-440x280.png", width: 440, height: 280 },
  { svg: "promo-marquee.svg", png: "promo-marquee-1400x560.png", width: 1400, height: 560 },
];

/** 16/48/128 are the manifest sizes; 128 doubles as the store icon. */
const ICON_SIZES = [16, 48, 128];

async function haveRsvg() {
  return run("rsvg-convert", ["--version"]).then(
    () => true,
    () => false,
  );
}

if (!(await haveRsvg())) {
  console.error(
    "render-assets: rsvg-convert not found.\n" +
      "  macOS:  brew install librsvg\n" +
      "  Debian: apt-get install librsvg2-bin",
  );
  process.exit(1);
}

await mkdir(assets, { recursive: true });

for (const tile of TILES) {
  await run("rsvg-convert", [
    join(assets, tile.svg),
    "-w", String(tile.width),
    "-h", String(tile.height),
    "-o", join(assets, tile.png),
  ]);
  const { size } = await stat(join(assets, tile.png));
  console.log(`render-assets: ${tile.png}  ${tile.width}×${tile.height}  ${(size / 1024).toFixed(0)} KB`);
}

for (const size of ICON_SIZES) {
  const out = join(icons, `icon-${size}.png`);
  await run("rsvg-convert", [join(icons, "icon.svg"), "-w", String(size), "-h", String(size), "-o", out]);
  console.log(`render-assets: icons/icon-${size}.png`);
}

const produced = (await readdir(assets)).filter((f) => f.endsWith(".png"));
console.log(
  `\nrender-assets: ${produced.length} tiles in store/assets, ${ICON_SIZES.length} icons in public/icons.` +
    "\nScreenshots are NOT generated here — they must come from the running extension.",
);
