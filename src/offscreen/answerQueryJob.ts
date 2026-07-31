/**
 * Offscreen query handler. Retrieval needs the embedder + IndexedDB (both live
 * here), and Nano/BYOK generation runs here too, so the whole query→answer path
 * executes in the offscreen doc and streams UI events back to the side panel.
 */

import type { SherpaDatabase } from "@/storage/db.js";
import type { PanelEvent } from "@/shared/answer.js";
import { chunkToSource } from "@/shared/answer.js";
import { getEmbedder } from "@/embed/embedder.js";
import { retrieve } from "@/retrieval/retrieve.js";
import { answerQuery } from "@/generator/answerService.js";
import { pickGenerator } from "@/generator/select.js";
import { loadSettings } from "@/settings/settings.js";
import { queryLogStore } from "@/gap/queryLog.js";

export async function runQuery(
  db: SherpaDatabase,
  indexId: string,
  query: string,
  emit: (event: PanelEvent) => void,
): Promise<void> {
  const settings = await loadSettings();
  const embedder = await getEmbedder();
  const generator = await pickGenerator(settings.answer);

  const deps = {
    retrieve: (q: string) => retrieve({ db, indexId, embedder }, q),
    generator,
    floor: settings.floor,
  };

  let answered = false;
  let topScore = 0;
  for await (const event of answerQuery(deps, query)) {
    if (event.kind === "sources") {
      answered = true;
      topScore = event.topScore;
      emit({ kind: "sources", tier: event.tier, sources: event.sources.map(chunkToSource) });
    } else if (event.kind === "refusal") {
      topScore = event.topScore;
      emit({ kind: "refusal", nearest: event.nearest.map(chunkToSource) });
    } else {
      emit(event); // delta | done
    }
  }
  // Log the query locally for the content-gap report (PRD 5.11.1).
  await queryLogStore.log(db, { indexId, query, topScore, answered, at: Date.now() });
}
