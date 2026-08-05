import { describe, it, expect } from "vitest";
import { EMBEDDING_MODELS, DEFAULT_EMBEDDING_MODEL_ID, findModel } from "./models.js";
import { EMBED_DIM } from "./vecmath.js";

describe("embedding model registry", () => {
  it("every model matches the stored vector width", () => {
    // Both bundled models happen to be EMBED_DIM. This is not a constraint of
    // the storage layer — `vectorStore.append` takes and records `dim` per
    // index — so a model of another size is addable; it just has to declare
    // that size here, because the embedder now reports `spec.dim`.
    // The sharded layout (5.5.2) is fixed at EMBED_DIM; a model with a
    // different width would silently corrupt existing shards.
    for (const m of EMBEDDING_MODELS) expect(m.dim).toBe(EMBED_DIM);
  });

  it("has a default that exists in the registry", () => {
    expect(EMBEDDING_MODELS.some((m) => m.id === DEFAULT_EMBEDDING_MODEL_ID)).toBe(true);
  });

  it("ids are unique", () => {
    const ids = EMBEDDING_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls back to the default for an unknown or missing id", () => {
    expect(findModel("nope/not-a-model").id).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(findModel(undefined).id).toBe(DEFAULT_EMBEDDING_MODEL_ID);
  });

  it("resolves a known id exactly", () => {
    for (const m of EMBEDDING_MODELS) expect(findModel(m.id)).toBe(m);
  });

  it("only the asymmetric model carries a query prefix", () => {
    const bge = findModel("Xenova/bge-small-en-v1.5");
    expect(bge.queryPrefix.length).toBeGreaterThan(0);
    expect(bge.pooling).toBe("cls");
    expect(findModel("Xenova/all-MiniLM-L6-v2").queryPrefix).toBe("");
  });
});
