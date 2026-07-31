import type { Turn } from "./types.js";

/**
 * Seeded demo conversation so the shell renders the approved design on load.
 * Replaced by live retrieval output in milestone #5.
 */
export const SEED_TURNS: readonly Turn[] = [
  {
    id: "seed-1",
    question: "How do I rotate an API key without breaking live integrations?",
    answer: {
      kind: "answer",
      tier: "nano",
      html: `<p>Northwind supports overlapping keys so you can rotate with zero downtime. Follow these steps:<a class="cite" href="#">1</a></p>
        <ol>
          <li>In <strong>Admin → API Keys</strong>, select the key and choose <strong>Generate successor</strong>. The original key stays active.<a class="cite" href="#">1</a></li>
          <li>Deploy the new key to your integrations. Both keys are accepted during the overlap window.<a class="cite" href="#">1</a></li>
          <li>Confirm traffic moved: the key's <code>Last used</code> timestamp updates within ~60 seconds.<a class="cite" href="#">2</a></li>
          <li>Once the old key shows no recent use, click <strong>Revoke predecessor</strong>.<a class="cite" href="#">1</a></li>
        </ol>
        <p>The default overlap window is <strong>30 days</strong>, capped at 90.<a class="cite" href="#">3</a></p>`,
      sources: [
        {
          index: 1,
          title: "Rotating API Keys Without Downtime",
          breadcrumb: "Admin › API Keys › Rotation",
          snippet:
            "Selecting “Generate successor” issues a new key while keeping the original active for the overlap window, so integrations migrate without interruption…",
          relevance: 94,
          url: "https://docs.northwind.com/admin/api-keys/rotation",
          displayUrl: "docs.northwind.com/admin/api-keys/rotation",
        },
        {
          index: 2,
          title: "Monitoring Key Usage & Activity",
          breadcrumb: "Admin › API Keys › Activity Log",
          snippet:
            "The Last used column reflects the most recent authenticated request against a key, updated in near real time…",
          relevance: 81,
          url: "https://docs.northwind.com/admin/api-keys/activity-log",
          displayUrl: "…/admin/api-keys/activity-log",
        },
        {
          index: 3,
          title: "API Key Policy & Limits",
          breadcrumb: "Reference › Security › Keys",
          snippet:
            "Overlap windows default to 30 days and are capped at 90 days. Windows may be shortened at any time…",
          relevance: 76,
          url: "https://docs.northwind.com/reference/security/keys",
          displayUrl: "…/reference/security/keys",
        },
      ],
    },
  },
];
