# Sherpa eval

Measures whether Sherpa answers **real** questions about a **real** help centre.
This is not the CI suite: `npm test` runs a hashed fixture embedder over twelve
invented chunks, which regression-tests fusion and refusal logic and tells you
nothing about answer quality.

## Running it

1. **Export a corpus.** Options → Indexes → **Export** on the site you want to
   measure. Save it as `eval/corpus.json`. Text only, no vectors — the harness
   recomputes those with whichever model it is testing.

2. **Label questions** in `eval/questions.jsonl` (format documented in the file).
   Draw them from support tickets and help-centre search logs. Invented questions
   use the docs' own words and hide the vocabulary mismatch that actually breaks
   retrieval.

3. **Run it.**

   ```bash
   npm run eval                          # retrieval only — seconds after the first run
   SHERPA_API_KEY=sk-... npm run eval    # also measures the generated answer
   ```

   Vectors are cached under `.eval-cache/` by content hash, so only new or
   changed chunks are re-embedded on later runs.

## Reading the report

Three numbers, deliberately not combined — "the answer was bad" has three
different causes and they need different fixes:

| Number | Means | Points at |
|---|---|---|
| `hit@k`, `MRR` | Did retrieval find the right article? | chunking, fusion, query expansion |
| `context coverage` | Did the assembled context contain the required facts? | article assembly, neighbour span, context budget |
| `answer coverage` | Did the answer keep them? | the model tier, the grounding prompt |

High recall + high context coverage + low answer coverage is a **generation**
problem. High recall + low context coverage is an **assembly** problem. A single
score hides both.

Two more, which trade against each other and must be read together:

- `false answers` — answered a question the docs don't cover.
- `missed answers` — refused a question whose article it had already retrieved.

Lowering the refusal floor improves the second and worsens the first. Tuning
either one alone is how a floor ends up wrong.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `SHERPA_CORPUS` | `eval/corpus.json` | exported index |
| `SHERPA_QUESTIONS` | `eval/questions.jsonl` | labelled set |
| `SHERPA_MODEL_ID` | bundled default | embedding model to test |
| `SHERPA_FLOOR` | shipped default | refusal threshold to test |
| `SHERPA_API_KEY` | — | set to measure generation too |
| `SHERPA_PROVIDER` | `anthropic` | `openai` / `anthropic` / `gemini` |
| `SHERPA_ANSWER_MODEL` | `claude-sonnet-5` | answering model |

Nothing here asserts a threshold. This run informs a decision; a gate would get
tuned until it passed.
