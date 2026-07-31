# Sherpa — Local-First Help-Site Answer Engine

A Chrome MV3 extension that crawls a documentation site, indexes it **entirely in the browser**, and answers questions from that index — no servers, no accounts, no per-query cost. Built from [`PRD-sherpa-local-help-search.md`](PRD-sherpa-local-help-search.md).

## Quick start

```bash
npm install
npm test          # 92 unit tests
npm run build     # → dist/
```

Then load it in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`. The toolbar icon (or `⌘⇧K` / `Ctrl+Shift+K`) opens the side panel; the **Options** page hosts crawl setup, indexes, and settings.

## Architecture (PRD §6)

| Context | Responsibility |
|---|---|
| **Side panel** (`src/sidepanel`) | React chat UI — grounded answers, citations, source cards, tier indicator |
| **Service worker** (`src/background`) | Thin lifecycle/routing; opens panel; creates the offscreen doc |
| **Offscreen document** (`src/offscreen`) | The crawl loop + embedding + retrieval + generation (dodges the 30s worker timeout) |
| **Options page** (`src/options`) | Live crawl setup, index management, settings |
| **IndexedDB** (`src/storage`) | Frontier, pages, chunks, sharded vectors, BM25, registry — versioned schema |

### The pipeline
`crawl` (`src/crawl`) → `extract` (`src/extract`) → `chunk` (`src/lib/chunk`) → `embed` (`src/embed`, transformers.js `all-MiniLM-L6-v2`) → `store` (`src/storage`) → `retrieve` (`src/retrieval`, hybrid dense+BM25 via RRF) → `answer` (`src/generator`, 3 tiers).

### Answer tiers (`src/generator`, PRD 5.8)
- **Tier 0 Extractive** — no model, always available; ranked passages + best sentences.
- **Tier 1 Nano** — Chrome built-in Gemini Nano (default), on-device, eviction-aware.
- **Tier 2 BYOK** — OpenAI / Anthropic / Gemini with your own key (the only egress path).

All three sit behind one `AnswerGenerator` interface; retrieval is agnostic to which is active.

## Privacy (PRD 5.10)
Zero backend. The only network traffic is: fetching the crawled site (as the signed-in user, via session cookies), a one-time model-weights download, and — only if BYOK is enabled — your chosen provider. No telemetry, no accounts. One-click **Delete everything** wipes the DB and settings.

## PRD coverage
- **P0 (v1) — complete & unit-tested.** Crawl (resumable, polite, robots-aware, auth-wall handling), extraction (lists/code/tables/anchors), chunking, embedding, sharded storage, hybrid retrieval + refusal floor, all three answer tiers, side-panel chat with citations + copy-with-citations + click-to-highlight, index management, settings, per-site permissions, quota pre-check, persistent storage, and the eval harness (Recall@k / false-answer-rate / groundedness gates).
- **Deferred (P1/P2, per PRD).** Incremental recrawl, content-gap report logic, SPA render fallback, platform extraction profiles, index export/import, WebGPU backend (needs transformers.js v3), and authoring the real golden/adversarial datasets (the harness that scores them is built).

## Testing
`npm test` runs 92 Vitest unit tests covering every pure module: URL canonicalization, robots, globs, chunking, RRF, cosine, BM25, hybrid retrieval, extraction (via linkedom), storage (via fake-indexeddb), the crawl engine (mock fetcher), the answer service, and the eval metrics.
