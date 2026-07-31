/**
 * First-run disclosure (PRD 5.10.4). Opened automatically on install, before
 * Sherpa has touched anything: what gets crawled, where it's stored, and what
 * leaves the machine (nothing). Plain language, no dark patterns, and it can't
 * be the thing a user discovers after the fact.
 */

export function Welcome({ onStart }: { onStart: () => void }): JSX.Element {
  return (
    <div className="page">
      <div className="eyebrow">First run</div>
      <h1>Sherpa works entirely on this device</h1>
      <p className="soft" style={{ maxWidth: "64ch" }}>
        Sherpa reads a documentation site, builds a private search index in your browser, and answers
        questions from that index. Before you start, here is exactly what it does.
      </p>

      <section className="card">
        <div className="card-head">
          <h2>What gets crawled</h2>
        </div>
        <div className="card-body stack-3">
          <p>
            Only the site you choose, and only pages under the crawl root you set. Sherpa asks for
            permission for that one site at the moment you start a crawl — it does not request access
            to your browsing in general.
          </p>
          <p className="help">
            Pages are fetched <strong>as you</strong>, reusing your existing browser session. That is
            what lets it reach an internal wiki or a customer-gated help centre. Sherpa never sees or
            stores your credentials, and it honours <span className="mono">robots.txt</span>,{" "}
            <span className="mono">Crawl-delay</span> and <span className="mono">noindex</span>.
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Where it's stored</h2>
        </div>
        <div className="card-body stack-3">
          <p>
            In your browser's local storage on this computer, and nowhere else. There is no Sherpa
            server, no account, and no sync. A 2,000-page site is roughly 45 MB.
          </p>
          <p className="help">
            You can delete any single index, or erase everything Sherpa holds, from{" "}
            <strong>Settings</strong> at any time.
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>What leaves this machine</h2>
        </div>
        <div className="card-body stack-3">
          <p>
            <strong>Nothing.</strong> Requests go to the site being crawled, and that is the only
            network traffic. The embedding model and its runtime ship inside the extension, so even
            the first index needs no download. There is no telemetry and no analytics.
          </p>
          <p className="help">
            One exception, entirely opt-in: if you configure your own API key under{" "}
            <strong>Settings → Answering model</strong>, then your question and the retrieved
            passages are sent to that provider to write the answer. Sherpa warns you in place before
            you enable it, and the default (Chrome's built-in on-device model) sends nothing.
          </p>
        </div>
      </section>

      <div className="row gap-2" style={{ marginTop: 8 }}>
        <button className="btn btn-primary" type="button" onClick={onStart}>
          Index a help site
        </button>
      </div>
    </div>
  );
}
