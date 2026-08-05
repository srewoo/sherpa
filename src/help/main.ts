/**
 * Entry for a static documentation page.
 *
 * It exists only to pull in the shared stylesheet through the bundler, the same
 * way the panel and options pages do — so these pages inherit the product's type
 * scale and palette instead of drifting into a second look, and the CSS is
 * hashed and bundled rather than referenced by a hand-written path.
 *
 * There is no behaviour here on purpose. A help page that needs JavaScript to be
 * readable is a help page that breaks when something else does.
 */
import "@/ui/styles.css";
