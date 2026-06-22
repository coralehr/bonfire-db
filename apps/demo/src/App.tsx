import { normalizeBaseUrl } from "@bonfire/sdk";

import "./styles.css";

const apiBaseUrl = normalizeBaseUrl(import.meta.env.VITE_BONFIRE_API_URL ?? "http://127.0.0.1:8080");

export function App() {
  return (
    <main className="shell">
      <section className="status-panel" aria-labelledby="bonfire-title">
        <div className="brand-mark" aria-hidden="true">
          B
        </div>
        <div>
          <p className="eyebrow">Local scaffold</p>
          <h1 id="bonfire-title">Bonfire DB</h1>
          <p className="summary">Foundation slice for the local clinical backend demo.</p>
        </div>
        <dl className="signals">
          <div>
            <dt>API</dt>
            <dd>{apiBaseUrl}/health</dd>
          </div>
          <div>
            <dt>Runtime</dt>
            <dd>Node 24 compatible</dd>
          </div>
          <div>
            <dt>Data</dt>
            <dd>Synthetic only</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
