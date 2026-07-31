# Sherpa — Local-First Help-Site Answer Engine

A Chrome MV3 extension that crawls a documentation site, indexes it **entirely in the browser**, and answers questions from that index — no servers, no accounts, no per-query cost. Built from [`PRD-sherpa-local-help-search.md`](PRD-sherpa-local-help-search.md).

## Quick start

```bash
npm install
npm test          # 176 unit tests, the eval gate, and the perf budgets
npm run build     # → dist/
```

Then load it in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`. On first install Sherpa opens its privacy disclosure; after that the toolbar icon (or `⌘⇧K` / `Ctrl+Shift+K`) opens the side panel, and the **Options** page hosts crawl setup, indexes, the gap report and settings.

The embedding model (~23 MB) is committed under `public/models/`, so a clone builds and runs offline. `npm run fetch:model` re-fetches it; `npm run build` copies the ONNX runtime out of `node_modules` into `public/ort/` automatically.

## Architecture (PRD §6)

| Context | Responsibility |
|---|---|
| **Side panel** (`src/sidepanel`) | React chat UI — grounded answers, citations, source cards, tier indicator, site switcher |
| **Service worker** (`src/background`) | Thin lifecycle/routing; opens the panel; creates the offscreen doc; resumes crawls on browser startup |
| **Offscreen document** (`src/offscreen`) | The crawl loop + embedding + retrieval + generation (dodges the 30s worker timeout) |
| **Options page** (`src/options`) | First-run disclosure, crawl setup, index management, gap report, settings |
| **IndexedDB** (`src/storage`) | Frontier, pages, chunks, sharded vectors, BM25 blob, query log, registry — versioned schema with migrations |

### The pipeline
`crawl` (`src/crawl`) → `extract` (`src/extract`, Readability + a structure-preserving walker) → `chunk` (`src/lib/chunk`) → `embed` (`src/embed`, transformers.js `all-MiniLM-L6-v2`) → `store` (`src/storage`) → `retrieve` (`src/retrieval`, hybrid dense+BM25 via RRF over a cached session) → `answer` (`src/generator`, 3 tiers).

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

- **176 unit tests** over every pure module — URL canonicalization, robots, `noindex`, globs, chunking, RRF, cosine, BM25 (including its persisted form), hybrid retrieval, extraction (via linkedom), storage and migrations (via fake-indexeddb), the crawl engine (mock fetcher), crawl preview, context packing, markdown rendering, the answer service, gap clustering, and the eval metrics.
- **The release gate** (`src/eval/pipeline.test.ts`) — the golden and adversarial sets run through the real retrieval path and assert M1 (Recall@5 ≥ 0.85) and M3 (false-answer ≤ 0.03).
- **Perf budgets** (`src/eval/perf.bench.test.ts`) — retrieval p95 at 15k chunks, currently **~14 ms** against the PRD's 150 ms budget (5.7.6).
- **`scripts/verify-bundle.mjs`** — asserts the built extension keeps `wasm-unsafe-eval` in its CSP and ships its runtime and weights locally. Both are invisible to unit tests and fatal at runtime, so CI checks them on every build.

CI (`.github/workflows/ci.yml`) runs typecheck → tests → build → bundle verification.

## PRD coverage

**P0 (v1) — complete.** Crawl setup with a real pre-flight estimate and quota refusal; a resumable, polite, robots/`Crawl-delay`/`noindex`-aware crawl that survives a browser restart; canonical-URL and content-hash dedupe; extraction preserving lists, code, tables and anchors; heading-aware chunking with small-page merge; sharded vectors, a persisted BM25 index and measured index sizes; hybrid retrieval with page dedupe, neighbour expansion and a refusal floor; all three answer tiers; the side panel with live index data, freshness, site switcher, markdown answers, numbered citations, copy-with-citations and click-to-highlight; index management with incremental refresh and full re-crawl; the first-run disclosure and one-click wipe; and the eval harness with its golden and adversarial sets.

**P1 also landed:** incremental recrawl, SPA render fallback, platform extraction profiles, the content-gap report with CSV/Markdown export, per-answer feedback, starter questions derived from the index, and BYOK.

**Genuinely deferred, per the PRD:** index export/import (5.6.7), single-URL add/remove (5.6.8), cross-encoder rerank (5.7.8), query rewriting for follow-ups (5.7.9), section filtering (5.7.7), int8 quantisation (5.5.7), scheduled recrawl (5.2.12), PDF extraction (5.1.8), doc-version detection (5.3.10), support-agent mode (5.12), and the WebLLM tier (§8.3).

Two caveats on the eval, so its numbers aren't read as more than they are. The golden and adversarial sets are authored against a fixture corpus, not the 100+ questions across three real help sites that §7.1 asks for — that has to be written against live sites. And the eval's embedder is a deterministic hashing stand-in, so the gate measures the retrieval *pipeline* (fusion, dedupe, expansion, refusal), not MiniLM's semantic recall. Both are documented in `src/eval/fixtures/`.
