/**
 * Render the design mockups to store-sized PNGs — as *previews*, not as
 * submission assets.
 *
 * Read this before using the output. Chrome Web Store screenshots must show the
 * extension actually running: the policy requires them to represent real
 * functionality, and a reviewer comparing a listing against the installed
 * extension is routine, not unlucky. These renders come from `design/*.html` —
 * hand-authored mockups with invented content (an "acme.test" help centre, a
 * fabricated conversation). They are the product's real design language, so they
 * are genuinely useful for settling the listing's layout, order and captions
 * before you go capturing. They are not a substitute for the capture.
 *
 * That is why the output lands in `store/screenshots/preview/` and never in
 * `store/screenshots/`, which is where `npm run shots:fit` puts the fitted real
 * captures that you actually upload. Nothing here can overwrite those.
 *
 * Rendering is offline and deterministic: the mockups link Google Fonts, so a
 * temporary mirror is built with that swapped for the Inter woff2 already
 * bundled in `public/fonts/`. The `design/` tree is never modified.
 *
 * Usage:  npm run capture:screenshots
 */

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const designDir = join(root, "design");
const outDir = join(root, "store", "screenshots", "preview");

/** The larger of the two sizes the store accepts, so captions stay legible. */
const TARGET = { width: 1280, height: 800 };

const CHROME =
  process.env["CHROME_BIN"] ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * The five surfaces worth listing, in the order they should appear in the store.
 *
 * Order is an argument, not an accident. The panel answer goes first because it
 * is the only screen that shows what the product *is* — everything else is setup
 * for it. The refusal goes last because it reads as a weakness in a list of
 * features and as the whole point once you've seen the answer: an index that
 * declines to guess is the differentiator against every "AI search" box.
 *
 * `caption` is the text to paste into the store's caption field, and it is
 * mirrored in `store/listing.md` so the two cannot drift silently.
 */
const SHOTS = [
  {
    file: "panel-chat-answer.html",
    name: "1-answer-with-citations",
    caption: "Answers from your own documentation, with every claim cited to the page it came from.",
  },
  {
    file: "crawl-setup.html",
    name: "2-crawl-setup",
    caption: "Point it at a docs site. It estimates pages, time and disk before it starts.",
  },
  {
    file: "index-management.html",
    name: "3-index-management",
    caption: "Several sites indexed side by side, each refreshable on its own.",
  },
  {
    file: "gap-report.html",
    name: "4-gap-report",
    caption: "See what people asked that your documentation could not answer.",
  },
  {
    file: "panel-chat-refusal.html",
    name: "5-honest-refusal",
    caption: "When the answer is not in the index, it says so instead of guessing.",
  },
];

/**
 * Swap the Google Fonts <link> block for the Inter woff2 we already bundle, and
 * fade the panel's scroll edge.
 *
 * The fade earns its place. The side panel is 400px by 720px and its
 * conversation scrolls, so any fixed-height render cuts the last message
 * somewhere — mid-word, hard-edged, directly against the composer, which reads
 * as a clipping bug rather than as a scrollable list. The fade says "more below"
 * in the way every scroll container does. It changes no content and no
 * geometry: the pixels above it are exactly what the mockup renders.
 */
const CAPTURE_CSS = `<style>
@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 400 600;
  font-display: block;
  src: url("inter-latin-0.woff2") format("woff2");
}
.panel-body {
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent 100%);
          mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent 100%);
}
</style>`;

const FONT_LINKS =
  /<link rel="preconnect"[^>]*>\s*|<link[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/g;

async function haveChrome() {
  return stat(CHROME).then(
    () => true,
    () => false,
  );
}

if (!(await haveChrome())) {
  console.error(
    `capture-screenshots: Chrome not found at\n  ${CHROME}\n\n` +
      "  Set CHROME_BIN to your Chrome binary and re-run, e.g.\n" +
      "    CHROME_BIN=/path/to/chrome npm run capture:screenshots",
  );
  process.exit(1);
}

const work = await mkdtemp(join(tmpdir(), "sherpa-shots-"));
await mkdir(outDir, { recursive: true });

try {
  // The mirror carries only what the mockups load: the shared stylesheet, the
  // font, and each page with its font <link> rewritten.
  await copyFile(join(designDir, "styles.css"), join(work, "styles.css"));
  await copyFile(
    join(root, "public", "fonts", "inter-latin-0.woff2"),
    join(work, "inter-latin-0.woff2"),
  );

  for (const shot of SHOTS) {
    const html = await readFile(join(designDir, shot.file), "utf8");
    await writeFile(
      join(work, shot.file),
      html.replace(FONT_LINKS, "").replace("</head>", `${CAPTURE_CSS}\n</head>`),
      "utf8",
    );
  }

  for (const shot of SHOTS) {
    const dest = join(outDir, `${shot.name}-${TARGET.width}x${TARGET.height}.png`);
    await run(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      // Fonts and layout settle well inside this; it also bounds a hung render.
      "--virtual-time-budget=3000",
      `--window-size=${TARGET.width},${TARGET.height}`,
      `--screenshot=${dest}`,
      `file://${join(work, shot.file)}`,
    ]);

    const { size } = await stat(dest);
    console.log(
      `capture-screenshots: ${shot.name}  ${(size / 1024).toFixed(0)} KB\n` +
        `  caption: ${shot.caption}`,
    );
  }

  await writeFile(
    join(outDir, "README.md"),
    `# Preview renders — NOT for submission\n\n` +
      `Generated by \`npm run capture:screenshots\` from the mockups in \`design/\`.\n` +
      `Regenerate freely; nothing here is hand-edited.\n\n` +
      `## Do not upload these\n\n` +
      `The content is invented — an \`acme.test\` help centre and a fabricated\n` +
      `conversation. Chrome Web Store screenshots must represent the extension's\n` +
      `real functionality, and a reviewer comparing the listing against the\n` +
      `installed extension is routine. Uploading these risks rejection, and would\n` +
      `misrepresent the product to anyone reading the listing.\n\n` +
      `## What they are for\n\n` +
      `Settling the listing before you capture: which surfaces to show, in what\n` +
      `order, with what captions. Also usable in a deck or a design review, where\n` +
      `"mockup" is understood.\n\n` +
      `## Replace each one with a real capture\n\n` +
      `| Preview | Capture instead, from the running extension |\n` +
      `|---|---|\n` +
      SHOTS.map(
        (s) =>
          `| \`${s.name}-${TARGET.width}x${TARGET.height}.png\` | ${s.caption.replace(/\|/g, "\\|")} |`,
      ).join("\n") +
      `\n\nPut real captures in \`store/screenshots/raw/\` and run \`npm run shots:fit\`.\n` +
      `Those land in \`store/screenshots/\` — a different folder, so a preview can\n` +
      `never be mistaken for a submission asset.\n`,
    "utf8",
  );

  console.log(
    `\ncapture-screenshots: ${SHOTS.length} previews in store/screenshots/preview/ ` +
      `at ${TARGET.width}×${TARGET.height}.\n\n` +
      "  These are PREVIEWS. They show mocked content and must not be uploaded.\n" +
      "  Capture the running extension into store/screenshots/raw/, then run\n" +
      "  `npm run shots:fit`. See store/SUBMISSION.md.",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
