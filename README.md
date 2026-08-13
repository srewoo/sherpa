# Sherpa — Local-First Help-Site Answer Engine

A Chrome MV3 extension that crawls a documentation site, indexes it **entirely in the browser**, and answers questions from that index — no servers, no accounts, no per-query cost. Built from [`PRD-sherpa-local-help-search.md`](PRD-sherpa-local-help-search.md).

## Quick start

```bash
npm install
npm test          # 590 unit tests, the eval gate, and the perf budgets
npm run build     # → dist/, plus artifacts/sherpa-<version>.zip for the store
```

Then load it in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`. On first install Sherpa opens its privacy disclosure; after that the toolbar icon (or `⌘⇧K` / `Ctrl+Shift+K`) opens the side panel, and the **Options** page hosts crawl setup, indexes, the gap report and settings.

The embedding model (~33 MB) is committed under `public/models/`, so a clone builds and runs offline. `npm run fetch:model` re-fetches it; `npm run build` copies the ONNX runtime out of `node_modules` into `public/ort/` automatically.

## Architecture (PRD §6)

| Context | Responsibility |
|---|---|
| **Side panel** (`src/sidepanel`) | React chat UI — grounded answers, citations, source cards, tier indicator, site switcher |
| **Service worker** (`src/background`) | Thin lifecycle/routing; opens the panel; creates the offscreen doc; resumes crawls on browser startup |
| **Offscreen document** (`src/offscreen`) | The crawl loop + embedding + retrieval + generation (dodges the 30s worker timeout) |
| **Options page** (`src/options`) | First-run disclosure, crawl setup, index management, gap report, settings |
| **IndexedDB** (`src/storage`) | Frontier, pages, chunks, sharded vectors, BM25 blob, query log, registry — versioned schema with migrations |

### The pipeline
`crawl` (`src/crawl`) → `extract` (`src/extract`, Readability + a structure-preserving walker) → `chunk` (`src/lib/chunk`) → `embed` (`src/embed`, transformers.js `bge-small-en-v1.5`, 384-d) → `store` (`src/storage`) → `retrieve` (`src/retrieval`) → `answer` (`src/generator`, 3 tiers).

### Retrieval

Modelled on the server-side KB engine, minus the server:

- **Field-weighted BM25** — `title ×2`, `section ×1.5`, `content ×1`, scored per field rather than over one flat blob, so a title match isn't drowned by body text.
- **Weighted score fusion** — dense and sparse lists are min-max normalised and combined 0.75/0.25, which ranks far better than rank-only RRF.
- **Two scores, kept apart.** The fused score *ranks* (relative to the query — min-max means the top hit is always ~1). Absolute cosine *decides*: it drives the refusal floor and is what a source card displays. Conflating them makes the adversarial false-answer rate 100%, which the eval catches.
- **Article assembly** — matched chunks are grouped by page and expanded with their neighbours, so a citation is a document, not a fragment, and the numbering in the answer matches the source cards exactly.
- **Page-context boost** — a question asked while reading a section favours that section (×1.15).
- **Learned pick prior** — a page previously chosen for a question like this one is nudged up (≤×1.12, decaying). Ranking only; see below.

### Answer tiers (`src/generator`, PRD 5.8)
- **Tier 0 Extractive** — no model, always available; ranked passages + best sentences.
- **Tier 1 Nano** — Chrome built-in Gemini Nano (default), on-device, eviction-aware, context packed to a token budget.
- **Tier 2 BYOK** — OpenAI / Anthropic / Gemini with your own key (the only egress path).

All three sit behind one `AnswerGenerator` interface; retrieval is agnostic to which is active.

## Privacy (PRD 5.10)

Zero backend, and — unusually for an in-browser RAG tool — **zero egress even on first run**. The ONNX runtime and the model weights are bundled in the extension rather than pulled from jsdelivr and Hugging Face, so the only network traffic is fetching the crawled site itself (as the signed-in user, via session cookies). No telemetry, no accounts. Host access is requested per-site at crawl time, never `<all_urls>` up front. One-click **Delete everything** wipes the database and settings — and reports honestly when another tab is holding the database open, rather than claiming a wipe that didn't happen.

The one exception is opt-in BYOK: with your own key configured, your question and the retrieved passages go to that provider. The UI says so in place.

## Quality gates

`npm test` runs the whole thing:

- **590 unit tests** over every pure module — URL canonicalization, robots, `noindex`, globs, chunking, RRF, cosine, BM25 (including its persisted form), hybrid retrieval, extraction (via linkedom), storage and migrations (via fake-indexeddb), the crawl engine (mock fetcher), crawl preview, context packing, markdown rendering, the answer service, gap clustering, and the eval metrics.
- **The release gate** (`src/eval/pipeline.test.ts`) — the golden and adversarial sets run through the real retrieval path and assert M1 (Recall@5 ≥ 0.85), M3 (false-answer ≤ 0.03) and **M4 (zero blocked turns)**.

  M4 exists because its absence let a dead end ship. It measures the *terminal state* of a turn — answer, refusal, or blocked — driven through the real `answerQuery` orchestration rather than through retrieval scores. A refusal is a legitimate outcome: it tells the user where they stand and shows the nearest pages. `blocked` — neither an answer nor a refusal — must be zero, and one is one too many. M1 and M3 were green throughout the bug and could not have been otherwise: recall measures ranking, false-answer rate measures answers that shouldn't have been given, and neither can see a turn that produced no outcome at all. `src/eval/eval.test.ts` asserts the gate actually fails on a blocked turn, because a gate that cannot fail is decoration.

  Deliberately written in terms of control flow rather than score magnitudes — the fixture embedder's cosines are nothing like bge's, so any gate phrased against the refusal floor would be measuring the fixture.
- **Multi-site calibration** (`npm run eval:sites`) — embeds three real crawled help centres with the actual bge weights and reads the answerable and unanswerable score distributions apart. This is what finally settled the refusal floor: the shipped 0.40 had a measured false-answer rate of **92% / 100% / 92%** across the three sites, because it sat below every negative bge produces. The default is now **0.70**, which clears the negatives' p95 on all three. It reports honestly that Gong and Mindtickle *overlap* — answerable p05 below negatives p95 — so no single threshold separates them, which is what per-index calibration and the three-band hedge exist for.
- **Perf budgets** (`src/eval/perf.bench.test.ts`) — retrieval p95 at 15k chunks against the PRD's 150 ms budget (5.7.6). Measured p95 varies with the machine (**~25–65 ms** across runs here), so the test asserts the budget rather than a headline figure; the bench prints p50/p95 on every run.
- **`scripts/verify-bundle.mjs`** — asserts the built extension keeps `wasm-unsafe-eval` in its CSP, ships its runtime and weights locally, and that **no shipped HTML or CSS references a remote origin**. All three are invisible to unit tests and fatal — or dishonest — at runtime, so CI checks them on every build. The last one exists because it wasn't checked: a `<link>` to `fonts.googleapis.com` sat in both entry points for the life of the project, blocking first paint on every panel open and quietly contradicting the zero-egress promise. Inter is now bundled (47 KB, `public/fonts/`).

CI (`.github/workflows/ci.yml`) runs typecheck → tests → build → bundle verification.

## Publishing

`npm run build` also writes `artifacts/sherpa-<version>.zip`, ready to upload. It
runs `verify-bundle.mjs` first and refuses to package a build whose CSP or
bundled assets would leave the extension broken on install.

Listing copy, per-permission justifications and the privacy policy live in
[`store/`](./store); [`store/SUBMISSION.md`](./store/SUBMISSION.md) covers the
process and the three things review tends to ask about.

## PRD coverage

**P0 (v1) — complete.** Crawl setup with a real pre-flight estimate and quota refusal; a resumable, polite, robots/`Crawl-delay`/`noindex`-aware crawl that survives a browser restart; canonical-URL and content-hash dedupe; extraction preserving lists, code, tables and anchors; heading-aware chunking with small-page merge; sharded vectors, a persisted BM25 index and measured index sizes; hybrid retrieval with page dedupe, neighbour expansion and a refusal floor; all three answer tiers; the side panel with live index data, freshness, site switcher, markdown answers, numbered citations, copy-with-citations and click-to-highlight; index management with incremental refresh and full re-crawl; the first-run disclosure and one-click wipe; and the eval harness with its golden and adversarial sets.

**Changing the embedding model.** Vectors from different models aren't comparable, so each index records the model that built it (`IndexMeta.embeddingModel`). Open an index built by another one and the panel says so and offers a rebuild, rather than returning confident nonsense.

**Scheduled refresh.** Docs drift, and a stale index still answers confidently — so the incremental refresh also runs on a cadence (30 days by default; 7/14/30/90 or off, in Settings). Three details make it unobtrusive rather than merely automatic: the alarm is a short *check* against each index's `lastIndexedAt` rather than a long timer, so a laptop asleep past its cadence refreshes on the next wake instead of skipping the cycle; a run only starts after five minutes of machine idle, at half rate and single-flight, and yields the moment the user returns; and because a background job has no user gesture to prompt with, an index whose host permission was revoked is marked **Needs access** in the Indexes table rather than failing silently.

**Answering beats asking.** Sherpa used to gate answers behind "Which of these did you mean?" when retrieval returned several close results. The rule was wrong three ways at once, and on a large help centre they compounded into a dead end: it thresholded on the *fused rank score*, which min-max normalisation pins at ≈1.0 for every query, so it was measuring how many similarly-titled pages the site had rather than anything about the question; it ran before generation, so a bad guess cost the answer entirely; and picking an option re-asked the chosen *title*, which retrieves that page plus its near-identical siblings at near-identical scores — the most reliably "ambiguous" input a corpus can produce — so the same three chips came back forever.

The design error underneath: **retrieval scatter is not intent ambiguity.** "How do I record a call?" has one clear intent; a help centre with two hundred call-related pages will always scatter. Asking the user to resolve that makes them fix the corpus's problem, not their own.

So refinement is advisory and terminal. The answer is generated and shown first, with alternatives offered underneath it (`src/retrieval/refine.ts`), scatter judged on **absolute cosine** — the score that is comparable across queries — rather than on a rank score that is not. Picking one scopes retrieval to that page's URL instead of re-searching its title, which makes a pick terminal by construction: one page cannot scatter, so there is no state to re-enter. And where a model is available, `src/retrieval/facet.ts` names the *axis* the alternatives differ along — "Which platform did you mean?" rather than three article titles, which is what a support engineer would actually ask. Every option must be traceable to a page retrieval returned; one value the corpus doesn't contain discards the whole facet.

**Query understanding.** Two additions target the failure that actually breaks help search — the user's words and the documentation's words are different words. **RM3 pseudo-relevance feedback** (`src/retrieval/expansion.ts`) runs the sparse query, borrows the vocabulary its top hits share, and fuses a second BM25 pass as its own low-weight retriever. Fusing rather than replacing is load-bearing: `Bm25Index.search` dedupes query terms, so an expanded query gives borrowed words the same weight as the user's own, and measurement showed that cost 1.5 points of hit@1. **HyDE** (`src/retrieval/hyde.ts`, opt-in) embeds a model-written hypothetical passage instead of the raw question, so the dense search compares passage to passage rather than question to passage. Both degrade to plain retrieval on any failure.

**Learning from picks.** Every refinement click is a relevance label — a human stating that *for this wording, this is the right document* — and they were being written to the query log and never read. `src/retrieval/prior.ts` folds them into a per-page, per-term prior that nudges ranking on later questions. Evidence is counted per *term*, not per page: a hub page picked once each for six unrelated questions would otherwise carry the same confidence on any one of them as a page chosen three times for precisely this wording. The boost is bounded (≤1.12), decays with a 30-day half-life, and — like the reranker — is applied to `rankScore` only, never to `similarity`, so a learned preference can reorder results but can never argue Sherpa past the refusal floor. This is the one capability a local index has that a hosted one structurally cannot match: the signal is generated, stored and applied without leaving the browser.

**Cross-encoder reranking** (`src/retrieval/rerank.ts`, opt-in) rescores the top 20 candidates with a model that reads the query and passage *together* — the thing a bi-encoder structurally cannot do. It is reordering only: `similarity` is untouched, so the refusal floor still decides on the same absolute cosine and a reranker cannot argue Sherpa into answering something it would refuse. The weights are **not committed** — `npm run fetch:reranker` vendors them (~23 MB, taking the package from 44 MB to 60 MB), and without them the setting is a no-op.

**P1 also landed:** incremental recrawl, SPA render fallback, platform extraction profiles, the content-gap report with CSV/Markdown export, per-answer feedback, starter questions derived from the index, and BYOK.

**Genuinely deferred, per the PRD:** index export/import (5.6.7), single-URL add/remove (5.6.8), section filtering (5.7.7), int8 quantisation (5.5.7), PDF extraction (5.1.8), doc-version detection (5.3.10), support-agent mode (5.12), and the WebLLM tier (§8.3). Cross-encoder rerank (5.7.8), query rewriting for follow-ups (5.7.9) and scheduled recrawl (5.2.12) have since landed and are described above.

Two caveats on the eval, so its numbers aren't read as more than they are. The golden and adversarial sets are authored against a fixture corpus, not the 100+ questions across three real help sites that §7.1 asks for — that has to be written against live sites. And the eval's embedder is a deterministic hashing stand-in, so the gate measures the retrieval *pipeline* (fusion, dedupe, expansion, refusal), not the embedding model's semantic recall. Both are documented in `src/eval/fixtures/`.
