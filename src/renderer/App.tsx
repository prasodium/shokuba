import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc/api'
import { useEvents } from './store/events'

const PLATFORM_NAMES: Record<AppInfo['platform'], string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const events = useEvents((state) => state.events)
  const ingest = useEvents((state) => state.ingest)

  useEffect(() => {
    // Subscribe first, then load history: nothing published in between can be missed,
    // and the store drops the duplicates this can produce.
    const unsubscribe = window.shokuba.events.subscribe((event) => ingest([event]))
    window.shokuba.events
      .list({ limit: 200 })
      .then(ingest)
      .catch((cause: unknown) => setError(String(cause)))
    window.shokuba.app
      .info()
      .then(setInfo)
      .catch((cause: unknown) => setError(String(cause)))
    return unsubscribe
  }, [ingest])

  return (
    <div className="shell">
      <header className="masthead">
        <div className="logo" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div>
          <h1>
            Shokuba <span className="kanji">職場</span>
          </h1>
          <p className="tagline">A Multi-Agent Harness</p>
        </div>
        <span className="phase">Phase 0 · Foundation</span>
      </header>

      {error && (
        <p role="alert" className="alert">
          Could not reach the main process: {error}
        </p>
      )}

      <section aria-label="System status" className="cards">
        <Card label="Version" value={info?.version ?? '…'} />
        <Card label="Platform" value={info ? PLATFORM_NAMES[info.platform] : '…'} />
        <Card
          label="Runtime"
          value={info ? `Electron ${info.electronVersion}` : '…'}
          hint={info ? `Node ${info.nodeVersion}` : undefined}
        />
        <Card
          label="Database"
          value={info ? `Schema v${info.schemaVersion}` : '…'}
          hint={
            info
              ? `${info.eventCount} ${info.eventCount === 1 ? 'event' : 'events'} recorded`
              : undefined
          }
        />
      </section>

      <section aria-label="Event log" className="panel">
        <div className="panel-head">
          <h2>Event log</h2>
          <span className="muted">Live · every event is persisted before it is shown</span>
        </div>
        {events.length === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          <ol className="events">
            {[...events].reverse().map((event) => (
              <li key={event.seq}>
                <span className="seq">#{event.seq}</span>
                <time dateTime={event.ts}>{new Date(event.ts).toLocaleTimeString()}</time>
                <span className="type">{event.type}</span>
                <span className={`badge badge-${event.source}`}>{event.source}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="note">
        The living office, agents and terminals arrive in the next phases. Everything on this screen
        is real state from the running app.
      </footer>
    </div>
  )
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="card">
      <span className="card-label">{label}</span>
      <span className="card-value">{value}</span>
      {hint && <span className="card-hint">{hint}</span>}
    </div>
  )
}
