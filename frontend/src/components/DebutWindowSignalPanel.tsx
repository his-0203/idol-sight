interface Props {
  videoId: string;
  signalBreakdown: string;   // JSON string from API
  onClose: () => void;
}

export function DebutWindowSignalPanel({ videoId, signalBreakdown, onClose }: Props) {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(signalBreakdown); } catch { /* keep empty */ }
  const ytUrl = `https://youtu.be/${videoId}`;

  return (
    <aside class="dw-signal-panel">
      <header>
        <h4>Signal Breakdown</h4>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </header>
      <a href={ytUrl} target="_blank" rel="noopener">Open on YouTube ↗</a>
      <dl>
        {Object.entries(parsed).map(([k, v]) => (
          <div class="dw-signal-row" key={k}>
            <dt>{k}</dt>
            <dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
          </div>
        ))}
      </dl>
      <p class="dw-signal-disclaimer">
        v1 heuristic — verify manually before external use.
      </p>
    </aside>
  );
}
