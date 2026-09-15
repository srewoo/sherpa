/**
 * Architectural contracts, checked by a machine.
 *
 * Sherpa's layering was real and entirely conventional: `domain` held pure
 * types, `lib` held generic helpers, feature modules sat above them and the UI
 * above those — and nothing anywhere enforced a line of it. The only thing
 * standing between that structure and a slow collapse into a ball of mutual
 * imports was whoever happened to be reading the diff.
 *
 * This is the equivalent of Echo's `.importlinter`, which encodes eight
 * contracts over its Python packages and runs them in CI. The rules below are
 * deliberately the ones that are true today: a rule that has to be suppressed
 * on the day it lands teaches the next person that these are advisory.
 *
 * Run with `npm run lint:deps`.
 */

/** Everything that is neither `domain` nor `lib` nor UI — the feature layer. */
const FEATURES = "^src/(crawl|embed|extract|generator|gap|permissions|retrieval|settings|storage)/";

module.exports = {
  forbidden: [
    {
      name: "domain-is-standalone",
      comment:
        "`domain` is the vocabulary the rest of the codebase is written in — records, " +
        "content blocks, the generator interface. It must depend on nothing, because the " +
        "moment it depends on a feature, that feature's types become everybody's types and " +
        "the layer stops meaning anything. It is also the one place with no tests of its own, " +
        "for exactly this reason: there is nothing there to test.",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { path: "^src/(?!domain/)", pathNot: "node_modules" },
    },
    {
      name: "lib-stays-generic",
      comment:
        "`lib` is chunking, hashing, URLs, robots, retry, breakers, PII, logging — things " +
        "that would be just as correct in another project. It may reach down into `domain` " +
        "for a shared type and no further. A `lib` module that imports `storage` or " +
        "`retrieval` is not a utility, it is a feature that has been filed in the wrong place, " +
        "and it drags the whole feature layer into every test that touches a helper.",
      severity: "error",
      from: { path: "^src/lib/" },
      to: { path: `${FEATURES}|^src/(sidepanel|options|ui|offscreen|background|eval)/` },
    },
    {
      name: "features-do-not-import-the-ui",
      comment:
        "Retrieval, generation, crawling and storage must not depend on the side panel, the " +
        "options page or the stylesheet. The direction is the product: the same pipeline runs " +
        "headless in the eval harness and in the offscreen document, neither of which has a " +
        "DOM to render into. One import the wrong way and the eval stops being able to run.",
      severity: "error",
      from: { path: FEATURES },
      to: { path: "^src/(sidepanel|options|ui)/" },
    },
    {
      name: "features-do-not-import-orchestration",
      comment:
        "`offscreen` and `background` are the wiring — they own message dispatch, the crawl " +
        "controller and the extension lifecycle. Features are called *by* them and must not " +
        "call back, or the layer that exists to be replaceable becomes load-bearing. The one " +
        "exception is the message contract in `background/messages*`, which is a shared type " +
        "declaration rather than behaviour.",
      severity: "error",
      from: { path: FEATURES },
      to: {
        path: "^src/(offscreen|background)/",
        pathNot: "^src/background/messages(\\.schema)?\\.ts$",
      },
    },
    {
      name: "eval-is-not-production",
      comment:
        "The eval harness builds corpora, fakes an embedder and sweeps thresholds. Nothing " +
        "that ships may import it — it would pull fixtures into the bundle and, worse, make " +
        "the measurement depend on the thing being measured.",
      severity: "error",
      from: { path: "^src/(?!eval/)", pathNot: "\\.(test|bench|eval)\\.ts$" },
      to: { path: "^src/eval/" },
    },
    {
      name: "ui-does-not-touch-the-crawler",
      comment:
        "The panel and the options page drive crawling by sending messages, never by calling " +
        "the crawl engine. A page that imports the engine directly runs it on the page's own " +
        "thread, outside the offscreen document that exists precisely so a 2,000-page crawl " +
        "does not block a UI — and outside the persistence that lets it resume.",
      severity: "error",
      from: { path: "^src/(sidepanel|options)/" },
      // `frontier` is excluded: it is a repository over the frontier store, and
      // the options page legitimately reads the failure log out of it to show
      // which URLs a crawl could not fetch. Reading crawl *state* is not the
      // same as driving the crawler, and a rule that conflates them teaches
      // people to suppress it.
      to: { path: "^src/crawl/(engine|politeness)\\.ts$" },
    },
    {
      name: "no-circular",
      comment:
        "A cycle means neither module can be understood, tested or replaced without the other, " +
        "and it defeats every layering rule above by construction.",
      severity: "error",
      from: {},
      // Type-only edges are excluded. `domain/records.ts` and
      // `domain/retrieval.ts` reference each other's interfaces — a stored
      // chunk is described in terms of a retrieved one and vice versa — and
      // those imports are erased at build time, so there is no cycle at
      // runtime and nothing to untangle. What this rule is for is a *value*
      // cycle, where two modules genuinely cannot be loaded or tested apart.
      to: { circular: true, dependencyTypesNot: ["type-only"] },
    },
    {
      name: "no-orphans",
      comment:
        "A module nothing imports is either dead code or a missing wire-up. Entry points, " +
        "type declarations and config are exempt because nothing is supposed to import them.",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.ts$",
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$",
          "\\.(test|bench|eval)\\.ts$",
          "^src/(offscreen/offscreen|background/service-worker|sidepanel/main|options/main|help/main|privacy/main)\\.tsx?$",
          "^src/manifest\\.config\\.ts$",
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
