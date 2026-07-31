import type { Turn } from "./types.js";
import { renderMarkdown } from "./markdown.js";

/**
 * A sample exchange used only when the panel is opened outside the extension
 * (`npm run dev` in a plain tab), so the design can be reviewed without
 * crawling a site first. Inside Chrome the panel always starts empty and every
 * answer comes from the live index.
 */
const SEED_MARKDOWN = `Northwind supports overlapping keys, so you can rotate with zero downtime [1].

1. In **Admin → API Keys**, select the key and choose **Generate successor**. The original key stays active [1].
2. Deploy the new key to your integrations. Both keys are accepted during the overlap window [1].
3. Confirm traffic moved: the key's \`Last used\` timestamp updates within ~60 seconds [2].
4. Once the old key shows no recent use, click **Revoke predecessor** [1].

The default overlap window is **30 days**, capped at 90 [3].`;

export const SEED_TURNS: readonly Turn[] = [
  {
    id: "seed-1",
    question: "How do I rotate an API key without breaking live integrations?",
    answer: {
      kind: "answer",
      tier: "nano",
      markdown: SEED_MARKDOWN,
      html: renderMarkdown(SEED_MARKDOWN),
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
