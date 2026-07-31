# PRD — "Sherpa": Local-First Help-Site Answer Engine

**A Chrome extension that crawls a documentation site, indexes it entirely in the browser, and answers questions from that index — with zero servers and zero per-query cost.**

| Field | Value |
|---|---|
| Product codename | Sherpa *(placeholder)* |
| Doc owner | Sharaj |
| Status | Draft v1.0 — for review |
| Date | 31 July 2026 |
| Target | Chrome MV3 extension, desktop |
| Primary domain | Help centres / documentation / knowledge bases |

---

## 0. Assumptions this document makes

Stated up front so reviewers can challenge them rather than discover them.

1. **Help sites, not the open web.** Optimised for `/docs`, `/help`, `/kb`, `/support` sites: mostly static HTML, sitemap present, consistent templates, procedural content. Not tuned for news, forums, or e-commerce.
2. **Single-site scope per index.** A user indexes one help centre at a time. Cross-site federated search is P2.
3. **Desktop Chrome only for v1.** No mobile, no Firefox/Safari (Prompt API and WebGPU story differ).
4. **~2,000 pages is the design point.** Architecture must hold to 10,000 pages without redesign, and is not expected to hold at 100,000.
5. **No backend of any kind in v1.** No auth, no accounts, no telemetry endpoint. This is a product constraint, not just a technical one.
6. **English-first.** Multilingual embedding is a known P2 lift.

---

## 1. Problem

Help centres are where knowledge goes to become unfindable. Three concrete failures:

**Site search is keyword-literal and shallow.** Most help centres ship whatever search their CMS gave them (Zendesk, Document360, Docusaurus/Algolia). It matches titles and tags, not meaning. "Why did my import fail silently" returns nothing; the answer lives in paragraph four of "Bulk Data Import — Troubleshooting."

**The answer is spread across pages.** Procedural help content is deliberately atomised. A real question ("how do I set up SSO for a sandbox tenant") touches three articles. Site search returns three links; the user assembles the answer manually, or gives up and files a ticket.

**Authenticated and internal docs are invisible to every AI tool.** ChatGPT/Claude with browsing can't reach an internal wiki or a customer-gated help centre. A browser extension crawls *as the signed-in user*, which is the single structural advantage that cannot be replicated server-side without an enterprise integration project.

The cost of these failures lands as **support ticket volume** — deflectable tickets where the answer was already published.

---

## 2. Users

### P0 — Internal support / CS agent *(primary)*
Answers customer questions all day against a help centre they know 70% of. Needs the *exact* answer with a link they can paste to the customer, in under 15 seconds, without leaving the ticket. Currently keeps 12 doc tabs open.
> **Success looks like:** answer + citation URL copied into a ticket reply, no tab switch.

### P0 — Power user / admin of a SaaS product
Configuring something non-trivial. Knows what they want, doesn't know what the docs call it. Reads docs the way one reads a manual under duress.
> **Success looks like:** got the right page and the right section on the first query.

### P1 — Solutions engineer / implementation consultant
Works across a partner or customer's *internal* documentation. The auth-crawl advantage is the entire reason they'd install this.

### P1 — Technical writer / docs owner
Doesn't want answers — wants to know **which questions their docs fail to answer**. The query gap report (§5.11) is built for this persona and is the most credible paid-tier hook.

### Explicit non-user
General web researchers who want to index arbitrary pages. Different crawl profile, different legal posture, different quality bar. Saying no keeps the product coherent.

---

## 3. Goals & non-goals

### Goals
- **G1** — Answer help-site questions faster and more accurately than the site's own search.
- **G2** — Answer strictly from indexed content, with a visible, verifiable citation on every answer.
- **G3** — Run entirely on-device: no server, no API key required, no recurring cost to the user or to us.
- **G4** — Index a 2,000-page site in one unattended session, resumable across browser restarts.
- **G5** — Work usefully on 100% of machines; work *excellently* on capable ones.

### Non-goals (v1)
- **NG1** — Not a general-purpose web crawler or archiver.
- **NG2** — Not a chatbot. No open-domain chat, no personality, no world knowledge. Out-of-index questions get "I don't have that in this index."
- **NG3** — No team/cloud sync of indexes.
- **NG4** — No writing, editing, or acting on the user's behalf.
- **NG5** — No WebLLM/local-1GB-model tier *(see §8.3 — deliberately deferred, possibly forever)*.

---

## 4. Success metrics

| # | Metric | Instrumentation | v1 target |
|---|---|---|---|
| M1 | **Recall@5** on a golden query set | Internal eval harness (§7) | ≥ 0.85 |
| M2 | **Groundedness** — answer claims traceable to cited chunks | LLM-judge eval | ≥ 0.95 |
| M3 | **False-answer rate** — confident answer when index lacks it | Adversarial eval set | ≤ 0.03 |
| M4 | **Time-to-answer**, query submit → first token | Local perf mark | p50 < 2s, p95 < 5s |
| M5 | **Crawl completion rate**, 2k-page site | Manual QA on 5 real sites | ≥ 95% of sitemap URLs |
| M6 | **Index build time**, 2k pages, WebGPU | Local timing | < 25 min unattended |
| M7 | **Citation click-through** | Local counter | ≥ 40% *(proxy for trust)* |
| M8 | **Week-2 retention** | Chrome Web Store | ≥ 25% |

M1–M3 gate release. M4–M6 are performance budgets. M7–M8 are post-launch health.

---

## 5. Features

Legend: **P0** = required for launch · **P1** = fast-follow · **P2** = later / conditional

---

### 5.1 Site scoping & crawl setup — P0

The onboarding step that determines everything downstream. Must take under 60 seconds.

| ID | Requirement | Pri |
|---|---|---|
| 5.1.1 | User initiates from any page; extension proposes crawl root from current URL | P0 |
| 5.1.2 | **Auto-discover `sitemap.xml`** (and `robots.txt` `Sitemap:` directive, and sitemap indexes) and use as primary seed | P0 |
| 5.1.3 | Fall back to link-following BFS from root when no sitemap | P0 |
| 5.1.4 | Show discovered page count *before* crawl starts, with an estimated duration | P0 |
| 5.1.5 | Include/exclude URL patterns (glob), pre-populated with sensible defaults (`/blog/*`, `/*?print=*`, `*.pdf` off by default) | P0 |
| 5.1.6 | Max-pages and max-depth caps, user-adjustable, defaulting to 5,000 / 10 | P0 |
| 5.1.7 | Detect known help-platform templates (Zendesk, Docusaurus, GitBook, Document360, Confluence, Intercom, Readme.io) and auto-apply an extraction profile | P1 |
| 5.1.8 | Crawl a **PDF-heavy** help site (many KBs ship PDFs) via in-browser PDF text extraction | P2 |

---

### 5.2 Crawl engine — P0

| ID | Requirement | Pri |
|---|---|---|
| 5.2.1 | Runs in an **offscreen document**, not the service worker — MV3 workers die at 30s idle | P0 |
| 5.2.2 | Frontier queue persisted to IndexedDB after every N pages; crawl **resumes** after browser restart or crash | P0 |
| 5.2.3 | Politeness: default 1 req/s, concurrency 3, per-host. User-adjustable within a hard ceiling | P0 |
| 5.2.4 | Honour `robots.txt` including `Crawl-delay`; honour `noindex` meta and `X-Robots-Tag` | P0 |
| 5.2.5 | Exponential backoff on 429/503; abort crawl and surface a clear error after N consecutive failures | P0 |
| 5.2.6 | Canonical URL dedupe: strip tracking params, respect `<link rel=canonical>`, normalise trailing slash and fragment | P0 |
| 5.2.7 | Content-hash dedupe — help sites serve identical content on many URLs | P0 |
| 5.2.8 | **Crawl uses the user's session cookies**, enabling authenticated/internal help centres | P0 |
| 5.2.9 | Live progress UI: pages fetched / queued / failed / skipped, current URL, ETA, pause & resume | P0 |
| 5.2.10 | Per-URL failure log, exportable, with reason codes | P1 |
| 5.2.11 | **SPA rendering fallback** — for JS-rendered docs, load in a background tab and read the settled DOM. Auto-triggered when static fetch yields < N words | P1 |
| 5.2.12 | Scheduled background recrawl (daily/weekly) | P2 |

---

### 5.3 Content extraction — P0

Where help-site tuning pays for itself. Generic Readability is the floor, not the ceiling.

| ID | Requirement | Pri |
|---|---|---|
| 5.3.1 | Mozilla **Readability.js** as base extractor | P0 |
| 5.3.2 | Strip nav, sidebar TOC, footer, cookie banners, "was this helpful?" widgets, related-articles rails | P0 |
| 5.3.3 | **Preserve ordered/unordered lists as structure.** Help content is procedural; flattening steps into prose destroys it | P0 |
| 5.3.4 | **Preserve code blocks verbatim** with language hint; never let the cleaner reflow them | P0 |
| 5.3.5 | **Preserve tables** as markdown (settings/permissions matrices are high-value answers) | P0 |
| 5.3.6 | Capture per-page metadata: title, breadcrumb trail, H1–H3 outline, canonical URL, `lastmod`, publish/update date | P0 |
| 5.3.7 | Capture **heading anchors** (`id`/`name`) so citations deep-link to the section, not the page top | P0 |
| 5.3.8 | Expand `<details>` / accordion / tabbed content before extraction — help sites hide half their content in collapsed panels | P0 |
| 5.3.9 | Capture image `alt` text and figure captions as text | P1 |
| 5.3.10 | Detect and record doc **version** from URL or version-selector (`/v2/`, `?version=`) | P2 |

---

### 5.4 Chunking — P0

| ID | Requirement | Pri |
|---|---|---|
| 5.4.1 | **Heading-aware splitting**: chunk boundaries respect H2/H3, never mid-section | P0 |
| 5.4.2 | Target 250–400 tokens, 15% overlap | P0 |
| 5.4.3 | Never split a code block, table, or ordered list across chunks | P0 |
| 5.4.4 | **Prepend breadcrumb + heading path** to each chunk's embedded text ("Admin > SSO > Troubleshooting: ..."). Materially improves retrieval on help content | P0 |
| 5.4.5 | Each chunk stores: text, page URL, anchor, heading path, position, page title, content hash | P0 |
| 5.4.6 | Small-page merge: pages under N tokens become a single chunk rather than a fragment | P0 |

---

### 5.5 Index & storage — P0

| ID | Requirement | Pri |
|---|---|---|
| 5.5.1 | Embeddings: `all-MiniLM-L6-v2` (384-dim) via transformers.js, WebGPU with WASM fallback | P0 |
| 5.5.2 | Vectors stored as **sharded `ArrayBuffer` blobs** (~5k vectors/shard), not one record per vector | P0 |
| 5.5.3 | Chunk text + metadata in a separate object store, keyed by vector index | P0 |
| 5.5.4 | **BM25 inverted index** built alongside — small, cheap, essential for exact terms | P0 |
| 5.5.5 | Request **persistent storage** (`navigator.storage.persist()`) to avoid silent eviction | P0 |
| 5.5.6 | Pre-flight quota check; refuse to start a crawl that won't fit and say so | P0 |
| 5.5.7 | int8 vector quantisation *(~4× smaller; measure recall delta before enabling)* | P1 |
| 5.5.8 | Model weights cached via Cache API — downloaded once, not per index | P0 |
| 5.5.9 | Index schema versioned, with a migration path | P0 |

**Storage budget, 2,000 pages / ~15k chunks:**

| Component | float32 | int8 |
|---|---|---|
| Vectors | ~23 MB | ~6 MB |
| Chunk text | ~15 MB | ~15 MB |
| BM25 index | ~5 MB | ~5 MB |
| Metadata | ~3 MB | ~3 MB |
| **Total** | **~46 MB** | **~29 MB** |
| Model weights (shared) | ~23 MB | ~23 MB |

---

### 5.6 Index management — P0

| ID | Requirement | Pri |
|---|---|---|
| 5.6.1 | Index list: site, page count, chunk count, size on disk, last-indexed date | P0 |
| 5.6.2 | **Freshness indicator** in chat ("indexed 12 days ago") with a refresh CTA | P0 |
| 5.6.3 | Delete an index; storage reclaimed and confirmed | P0 |
| 5.6.4 | Full re-crawl | P0 |
| 5.6.5 | **Incremental recrawl** using ETag / `Last-Modified` / content hash — only changed pages re-embedded | P1 |
| 5.6.6 | Multiple indexes with a site switcher in chat | P1 |
| 5.6.7 | Export / import an index as a file *(unlocks "one person indexes, the team imports")* | P1 |
| 5.6.8 | Add or remove a single URL from an existing index | P2 |

---

### 5.7 Retrieval — P0

| ID | Requirement | Pri |
|---|---|---|
| 5.7.1 | **Hybrid retrieval**: dense cosine + BM25, fused via Reciprocal Rank Fusion | P0 |
| 5.7.2 | Brute-force cosine over `Float32Array`. No ANN index — unnecessary below ~500k chunks | P0 |
| 5.7.3 | Vectors loaded to memory once per session; lazy-load on first query | P0 |
| 5.7.4 | Retrieve top-k (default 20) → dedupe by page → assemble top-N chunks for generation | P0 |
| 5.7.5 | **Neighbour expansion**: pull adjacent chunks of a hit so procedures aren't truncated mid-steps | P0 |
| 5.7.6 | Retrieval latency budget: p95 < 150 ms at 15k chunks | P0 |
| 5.7.7 | Filter by breadcrumb section ("only Admin Guide") | P1 |
| 5.7.8 | Cross-encoder rerank of top-20 *(quality/latency tradeoff — measure first)* | P2 |
| 5.7.9 | Query rewriting for follow-ups ("and for sandbox?" → standalone query) | P1 |

---

### 5.8 Answer generation — P0

Three tiers behind one interface: `answer(query, chunks) → string | AsyncIterable<string>`. Retrieval is agnostic to which is active.

| ID | Requirement | Pri |
|---|---|---|
| 5.8.1 | **Tier 0 — Extractive.** Ranked passages, best-matching sentences highlighted, heading path shown. No model. Works on every machine, always | P0 |
| 5.8.2 | **Tier 1 — Chrome Prompt API (Gemini Nano).** On-device, free, stable access for extensions without an origin trial | P0 |
| 5.8.3 | Availability detection via `LanguageModel.availability()`; handle `available` / `downloadable` / `downloading` / `unavailable` distinctly | P0 |
| 5.8.4 | Handle **model eviction** — Nano is removed if free disk drops below ~10 GB. Detect and degrade to Tier 0 without an error state | P0 |
| 5.8.5 | Nano context budget: 4–6 chunks max. Select by fused score, packed to a token budget | P0 |
| 5.8.6 | **Tier 2 — BYO API key.** User supplies their own key; stored in `chrome.storage.local`, never transmitted anywhere but the chosen provider | P1 |
| 5.8.7 | Strict grounding prompt: answer only from context; if absent, say so | P0 |
| 5.8.8 | **Refusal path**: below a retrieval-score floor, skip generation entirely and return "not in this index" + nearest pages | P0 |
| 5.8.9 | Streaming output | P0 |
| 5.8.10 | Preserve procedural structure — if the source is numbered steps, the answer is numbered steps | P0 |
| 5.8.11 | Tier indicator in UI so quality expectations are calibrated | P0 |

---

### 5.9 Chat interface — P0

| ID | Requirement | Pri |
|---|---|---|
| 5.9.1 | Chrome **side panel** (persists across navigation, unlike a popup) | P0 |
| 5.9.2 | Keyboard shortcut to open and focus input | P0 |
| 5.9.3 | Multi-turn within a session, with history cleared on index switch | P0 |
| 5.9.4 | **Source cards under every answer**: page title, breadcrumb, snippet, relevance | P0 |
| 5.9.5 | Click a source → open page at the anchor **and highlight the passage** in-page | P0 |
| 5.9.6 | **Copy answer with citations** as markdown *(agent workflow: straight into a ticket reply)* | P0 |
| 5.9.7 | Empty-state suggests starter questions derived from top-level headings | P1 |
| 5.9.8 | Per-answer 👍/👎 stored locally, feeding the gap report | P1 |
| 5.9.9 | Recent-query history with re-run | P1 |
| 5.9.10 | Inline citation markers `[1]` mapped to source cards | P1 |

---

### 5.10 Privacy & permissions — P0

| ID | Requirement | Pri |
|---|---|---|
| 5.10.1 | **Zero network egress** in the default configuration, except fetching the crawled site and the one-time model download | P0 |
| 5.10.2 | No analytics, no telemetry, no accounts in v1 | P0 |
| 5.10.3 | Minimal permission set; `host_permissions` requested per-site at crawl time, not `<all_urls>` up front | P0 |
| 5.10.4 | Plain-language disclosure on first run: what is crawled, where it's stored, what leaves the machine (nothing) | P0 |
| 5.10.5 | If BYOK is enabled, explicit warning that queries and chunks now leave the device | P1 |
| 5.10.6 | One-click "delete everything" | P0 |

---

### 5.11 Content gap report — P1 *(strategic)*

The docs-owner feature. Turns a consumer tool into something a company will pay for.

| ID | Requirement | Pri |
|---|---|---|
| 5.11.1 | Log every query with its top retrieval score, locally | P1 |
| 5.11.2 | Flag queries that fell below the refusal floor, or got 👎 | P1 |
| 5.11.3 | Cluster failed queries by semantic similarity | P1 |
| 5.11.4 | Report: "N users asked about X, no adequate content exists" | P1 |
| 5.11.5 | Export as CSV/markdown for the docs backlog | P1 |
| 5.11.6 | Aggregate across a team *(requires a backend — deliberately out of v1)* | P2 |

---

### 5.12 Support-agent mode — P2

| ID | Requirement | Pri |
|---|---|---|
| 5.12.1 | Paste a raw customer question; extension extracts the searchable intent | P2 |
| 5.12.2 | Generate a customer-ready reply with doc links, in a configurable tone | P2 |
| 5.12.3 | Snippet library for recurring answers | P2 |

---

## 6. Technical architecture (summary)

```
┌─ Side Panel (React) ──────────── chat UI, sources, settings
│
├─ Service Worker ──────────────── routing, lifecycle, shortcuts (short-lived)
│
├─ Offscreen Document ─────────── crawl loop, extraction, embedding
│     └─ Web Worker ────────────── transformers.js inference (WebGPU → WASM)
│
├─ Background Tab (on demand) ─── SPA rendering fallback
│
└─ IndexedDB
      ├─ frontier      queue state, resumable
      ├─ pages         url, html-hash, etag, lastmod, metadata
      ├─ chunks        text + metadata, keyed by vector index
      ├─ vectors       sharded ArrayBuffers
      ├─ bm25          inverted index
      └─ meta          schema version, index registry
```

**Load-bearing decisions**
1. Offscreen document for the crawl — the MV3 30s worker timeout makes anything else non-viable.
2. Sharded vector blobs — per-record IndexedDB reads at 15k records is the classic performance trap.
3. Hybrid retrieval from day one — dense-only fails on exact terms, which is *most* help-site queries.
4. Generator behind an interface — lets the LLM tier change without touching the index.
5. Brute-force search — an ANN index at this scale is complexity with no payoff.

---

## 7. Quality & eval framework — P0 *(internal)*

Not a shippable feature. Ships before v1 anyway, because a RAG system that *feels* right while retrieving garbage is the default outcome.

| ID | Requirement |
|---|---|
| 7.1 | **Golden set**: 100+ questions across 3 real help sites, each with hand-labelled correct source chunk(s) |
| 7.2 | Recall@1 / @5 / @10 measured on every retrieval change |
| 7.3 | **Adversarial set**: 30 questions with no answer in the index — measures false-answer rate (M3) |
| 7.4 | Groundedness judge: does every answer claim trace to a cited chunk? |
| 7.5 | Extraction regression suite: fixture HTML from each help platform, asserting code blocks / tables / lists survive |
| 7.6 | Perf benchmarks: index build, query latency, memory ceiling — asserted in CI |
| 7.7 | Chunking ablation harness: size, overlap, breadcrumb-prefix on/off |

---

## 8. Risks & open questions

### 8.1 Product

| Risk | Sev | Mitigation |
|---|---|---|
| First-run crawl (20–25 min) causes abandonment before value is seen | **High** | Make the index **progressively queryable** — answer from what's indexed so far, show coverage %. Do not gate the UI on completion |
| Nano quality below expectation; users blame the product | **High** | Extractive tier as the credible floor; always show sources; BYOK escape hatch |
| Nano unavailable on ~40% of machines | **Med** | Tier 0 is a real product, not a fallback. Never show a dead end |
| Answers confidently from stale index | **Med** | Freshness badge + incremental recrawl (5.6.5) |

### 8.2 Technical

| Risk | Sev | Mitigation |
|---|---|---|
| WASM-only embedding: 2k pages ≈ 15–25 min | **Med** | Detect and warn with a real ETA; offer reduced scope; run in a worker |
| IndexedDB eviction destroys the index | **Med** | `navigator.storage.persist()` (5.5.5) + graceful rebuild |
| Nano evicted when disk drops below 10 GB | **Med** | Re-check availability per session (5.8.4) |
| JS-rendered docs return empty | **Med** | Word-count heuristic → tab-render fallback (5.2.11) |
| Memory pressure holding 23 MB of vectors + model | **Low** | Measure; shard-on-demand if p95 memory exceeds budget |

### 8.3 Deferred: WebLLM

A ~1GB local model (Qwen2.5-1.5B class) would serve users who have neither Nano nor a willingness to bring a key. **Explicitly out of scope.** The download cost is fatal to first-run UX, and the segment is hypothetical until proven. The generator interface (5.8) makes it a drop-in later if the data demands it. Revisit only if post-launch data shows the "no Nano, no key" bucket exceeds 25% of active users.

### 8.4 Open questions

1. **Legal posture on crawling third-party help sites.** Local-only storage and single-user scope is a defensible position, but not a settled one. Needs a real read before public distribution. Internal/first-party sites are unambiguous.
2. **Chrome Web Store review risk** — broad `host_permissions` + crawling behaviour may attract scrutiny. Per-site opt-in permission (5.10.3) is designed partly for this.
3. **int8 quantisation recall cost** — measure before committing (5.5.7).
4. **Is the docs-owner (gap report) the real buyer** rather than the agent? Changes positioning and possibly the whole roadmap.

---

## 9. Business analysis

### 9.1 Why this wins vs. alternatives

| Alternative | Gap it leaves |
|---|---|
| Native site search (Zendesk/Algolia) | Keyword-literal; no synthesis; no cross-page answers |
| Vendor's own "AI help" widget | Only on sites whose vendor built one; no internal wikis; vendor controls quality |
| ChatGPT / Claude with browsing | Can't reach authenticated or internal docs; no persistent index; per-query cost |
| Hosted RAG (Glean, Danswer, Dashworks) | Enterprise sales cycle, per-seat pricing, IT project to deploy, data leaves the org |
| Generic "chat with page" extensions | Single-page context only; the whole point here is the *whole site* |

**The defensible wedge:** authenticated crawl + zero marginal cost + zero data egress. No hosted product can offer all three simultaneously.

### 9.2 Value hypothesis

For a 20-agent support team, if the tool deflects 5 minutes per ticket on 15% of tickets, that's meaningful headcount-equivalent. But this is unvalidated — **the first post-launch job is measuring actual time-to-answer against baseline site search**, not building features.

### 9.3 Distribution & monetisation

- **Free tier, permanently free:** everything in §5 at P0. Zero marginal cost per user makes this honest, not a loss-leader.
- **Paid hypothesis (v2+):** team index sharing, aggregated gap reports, admin-managed index distribution. All require the backend v1 deliberately avoids — which is the correct sequencing, since it forces free-tier value to be proven first.
- **Distribution:** Chrome Web Store; land via docs/support communities and the "internal wiki" use case, which is where the structural advantage is most obvious.

### 9.4 Build cost, rough order

| Phase | Scope | Est. |
|---|---|---|
| M1 | Crawl + extract + chunk + store, no UI | 2–3 wks |
| M2 | Embeddings + hybrid retrieval + eval harness | 2 wks |
| M3 | Side panel, Tier 0 + Tier 1 answers, citations | 2 wks |
| M4 | Index management, polish, Web Store submission | 1–2 wks |
| **v1** | | **7–9 wks** |
| M5 | Incremental recrawl, BYOK, multi-index, gap report | 3–4 wks |

---

## 10. Release plan

**Alpha (internal)** — one help site, hardcoded config, Tier 0 only. Goal: validate crawl completeness and retrieval quality against the golden set. Ship nothing until M1 ≥ 0.85.

**Beta (limited)** — full P0 set, 10–20 support agents on a real help centre. Goal: M4 (latency), M7 (citation trust), and qualitative "did you stop opening 12 tabs."

**v1 (public)** — P0 complete, all metrics at target, legal review closed.

**v1.1** — P1 set, prioritised by beta signal.

---

## 11. Appendix — v1 requirement checklist

**P0:** 5.1.1–5.1.6 · 5.2.1–5.2.9 · 5.3.1–5.3.8 · 5.4.1–5.4.6 · 5.5.1–5.5.6, 5.5.8, 5.5.9 · 5.6.1–5.6.4 · 5.7.1–5.7.6 · 5.8.1–5.8.5, 5.8.7–5.8.11 · 5.9.1–5.9.6 · 5.10.1–5.10.4, 5.10.6 · 7.1–7.7

**P1:** 5.1.7 · 5.2.10, 5.2.11 · 5.3.9 · 5.5.7 · 5.6.5–5.6.7 · 5.7.7, 5.7.9 · 5.8.6 · 5.9.7–5.9.10 · 5.10.5 · 5.11.1–5.11.5

**P2:** 5.1.8 · 5.2.12 · 5.3.10 · 5.6.8 · 5.7.8 · 5.11.6 · 5.12.1–5.12.3 · WebLLM tier
