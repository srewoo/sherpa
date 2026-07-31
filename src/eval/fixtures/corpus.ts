/**
 * A miniature help centre, used as the eval corpus (PRD §7).
 *
 * This is a stand-in, not the real thing: §7.1 calls for 100+ hand-labelled
 * questions across three *real* help sites, which has to be authored against
 * live sites rather than invented here. What this fixture does give us is a
 * corpus with the properties help content actually has — procedural steps,
 * near-duplicate topics, exact-term queries (error codes, flag names) that dense
 * retrieval alone fails — so the harness, the metrics and the release gate are
 * exercised end to end and regressions in ranking show up in CI.
 *
 * Chunks are written the way the pipeline stores them: `text` carries the
 * breadcrumb + heading prefix that gets embedded, `body` is what a user reads.
 */

export interface FixtureChunk {
  readonly id: number;
  readonly url: string;
  readonly headingPath: string;
  readonly body: string;
}

function chunk(id: number, url: string, headingPath: string, body: string): FixtureChunk {
  return { id, url, headingPath, body };
}

export const CORPUS: readonly FixtureChunk[] = [
  chunk(
    0,
    "https://help.acme.test/admin/sso/setup",
    "Admin > SSO > Setup",
    "To enable SAML single sign-on, open Admin then Security then Single sign-on. Upload your identity provider metadata XML and set the audience URI to your tenant URL.",
  ),
  chunk(
    1,
    "https://help.acme.test/admin/sso/setup",
    "Admin > SSO > Setup",
    "After uploading metadata, assign at least one test user to the application before enforcing SSO for everyone, or you can lock yourself out of the tenant.",
  ),
  chunk(
    2,
    "https://help.acme.test/admin/sso/sandbox",
    "Admin > SSO > Sandbox tenants",
    "Sandbox tenants use a separate audience URI ending in -sandbox. Configure SSO for a sandbox tenant exactly as production, but point the identity provider at the sandbox login URL.",
  ),
  chunk(
    3,
    "https://help.acme.test/admin/sso/troubleshooting",
    "Admin > SSO > Troubleshooting",
    "Error AUTH-403 means the audience URI in the assertion does not match the tenant. Check for a trailing slash, and confirm you are not using the production URI on a sandbox tenant.",
  ),
  chunk(
    4,
    "https://help.acme.test/data/import",
    "Data > Bulk import > Running an import",
    "Upload a CSV under Data then Import. The first row must be a header. Imports run asynchronously and you receive an email when the job finishes.",
  ),
  chunk(
    5,
    "https://help.acme.test/data/import-troubleshooting",
    "Data > Bulk import > Troubleshooting",
    "An import can finish with status Completed while silently skipping rows. Rows are skipped without an error when a required column is absent from the header, so the importer cannot map them. Open the job report to see the skipped-row count.",
  ),
  chunk(
    6,
    "https://help.acme.test/data/import-troubleshooting",
    "Data > Bulk import > Troubleshooting",
    "Validation failures are different from skipped rows: a validation failure rejects the whole file and reports the offending line number.",
  ),
  chunk(
    7,
    "https://help.acme.test/api/webhooks",
    "Developers > Webhooks > Delivery",
    "Webhooks are retried with exponential backoff on any non-2xx response. There are five retry attempts over roughly 30 minutes, after which the delivery is marked failed.",
  ),
  chunk(
    8,
    "https://help.acme.test/api/webhooks",
    "Developers > Webhooks > Delivery",
    "Set the X-Signature header check on your endpoint to verify payload authenticity before processing a webhook.",
  ),
  chunk(
    9,
    "https://help.acme.test/api/keys",
    "Developers > API keys > Rotation",
    "Choose Generate successor to issue a new API key while the original stays valid. The overlap window defaults to 30 days and is capped at 90. Revoke the predecessor once traffic has moved.",
  ),
  chunk(
    10,
    "https://help.acme.test/billing/seats",
    "Billing > Seats > Adding users",
    "Adding a user consumes a seat immediately and prorates the charge to your next invoice. Deactivating a user releases the seat at the end of the billing period.",
  ),
  chunk(
    11,
    "https://help.acme.test/billing/invoices",
    "Billing > Invoices > Downloading",
    "Invoices are available under Billing then Invoices for 24 months. Download them individually as PDF, or export a CSV summary for a date range.",
  ),
];

/** The embedded form: breadcrumb + heading path prefix, as chunk.ts produces. */
export function embeddedText(c: FixtureChunk): string {
  return `${c.headingPath}:\n${c.body}`;
}

export interface GoldenQuery {
  readonly query: string;
  /** Chunk ids that genuinely answer the question. */
  readonly relevant: readonly number[];
}

/**
 * Golden set (§7.1/7.2). Deliberately includes the failure modes the PRD calls
 * out: questions whose answer sits mid-article rather than in a title (§1),
 * questions spanning two pages, and exact-term lookups that dense-only
 * retrieval misses.
 */
export const GOLDEN: readonly GoldenQuery[] = [
  { query: "how do I set up SAML single sign-on", relevant: [0] },
  { query: "configure SSO for a sandbox tenant", relevant: [2] },
  { query: "what does AUTH-403 mean", relevant: [3] },
  { query: "audience URI mismatch after enabling sso", relevant: [3] },
  { query: "avoid locking myself out when enforcing sso", relevant: [1] },
  { query: "why did my import fail silently", relevant: [5] },
  { query: "import skipped rows without an error", relevant: [5] },
  { query: "difference between skipped rows and validation failure", relevant: [5, 6] },
  { query: "how many times is a webhook retried", relevant: [7] },
  { query: "verify a webhook payload is authentic", relevant: [8] },
  { query: "rotate an api key without breaking integrations", relevant: [9] },
  { query: "how long is the api key overlap window", relevant: [9] },
  { query: "does adding a user cost money immediately", relevant: [10] },
  { query: "download an invoice as PDF", relevant: [11] },
  { query: "export invoices for a date range", relevant: [11] },
  { query: "upload a CSV to import data", relevant: [4] },
];

/**
 * Adversarial set (§7.3): plausible questions this corpus cannot answer. A
 * confident answer to any of these is a false answer (M3).
 */
export const ADVERSARIAL: readonly string[] = [
  "how do I delete my account permanently",
  "what is the SLA for enterprise support",
  "does the product work offline on mobile",
  "how do I configure SCIM user provisioning",
  "what is the maximum file size for attachments",
  "can I self-host the application",
  "how do I request a SOC 2 report",
  "what regions is data stored in",
  "how do I set up two-factor authentication",
  "is there a Terraform provider",
];
