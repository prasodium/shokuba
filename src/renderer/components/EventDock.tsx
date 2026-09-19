import { useState } from 'react'
import { useEvents } from '../store/events'
import { useOffice } from '../store/office'

/** The live event log: everything the office shows comes from these, persisted first. */
export function EventDock() {
  const events = useEvents((s) => s.events)
  const info = useOffice((s) => s.info)
  const [open, setOpen] = useState(true)
  const shown = [...events].slice(-60).reverse()

  return (
    <section className={`dock ${open ? 'is-open' : ''}`} aria-label="Event log">
      <div className="dock-head">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'} Event log
        </button>
        <span className="muted">
          {events.length} recent · every event is saved before it is shown
          {info && ` · schema v${info.schemaVersion}`}
        </span>
      </div>
      {open && (
        <ol className="events">
          {shown.length === 0 && <li className="muted">No events yet.</li>}
          {shown.map((event) => (
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
  )
}
