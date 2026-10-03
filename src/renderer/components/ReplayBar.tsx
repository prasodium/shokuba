import { positionLabel } from '../replay/labels'
import { SPEEDS } from '../replay/replayer'
import { useMissions } from '../store/missions'
import { useOffice } from '../store/office'
import { useTimeline } from '../store/timeline'

const time = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/**
 * Replay's controls, under the office. Live, it is one button. In replay it plays, pauses, steps,
 * changes speed, scrubs and narrows to a mission or an employee, and "Back to live" is always there.
 */
export function ReplayBar() {
  const mode = useTimeline((s) => s.mode)
  const loaded = useTimeline((s) => s.loaded)
  const error = useTimeline((s) => s.error)
  const events = useTimeline((s) => s.events)
  const cursor = useTimeline((s) => s.cursor)
  const playing = useTimeline((s) => s.playing)
  const speed = useTimeline((s) => s.speed)
  const filter = useTimeline((s) => s.filter)
  const matches = useTimeline((s) => s.matches)
  const range = useTimeline((s) => s.range)
  const actions = useTimeline.getState()
  const missions = useMissions((s) => s.missions)
  const employees = useOffice((s) => s.employees)

  if (mode === 'live') {
    return (
      <div className="replay-bar">
        <button
          type="button"
          className="btn"
          onClick={() => void actions.enter()}
          title="Scrub back through what was recorded. Nothing can be changed while replaying."
        >
          Replay
        </button>
        {error ? (
          <span className="field-error" role="alert">
            {error}
          </span>
        ) : (
          <span className="muted">Watch what was recorded play back, read only.</span>
        )}
      </div>
    )
  }

  if (mode === 'loading') {
    return (
      <div className="replay-bar is-replay">
        <span className="replay-label">Replay</span>
        <span className="muted" role="status">
          Reading the event log… {loaded.toLocaleString()} events
        </span>
        <button type="button" className="btn" onClick={actions.exit}>
          Back to live
        </button>
      </div>
    )
  }

  const filterValue = filter ? `${filter.kind}:${filter.id}` : ''
  const empty = events.length === 0

  return (
    <div className="replay-bar is-replay" role="toolbar" aria-label="Replay">
      <span className="replay-label">Replay</span>
      <button
        type="button"
        className="btn"
        aria-label="Previous event"
        title="Previous event"
        disabled={cursor <= range.from}
        onClick={() => actions.step(-1)}
      >
        ◀︎
      </button>
      <button
        type="button"
        className="btn btn-primary"
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={empty}
        onClick={() => (playing ? actions.pause() : actions.play())}
      >
        {playing ? 'Pause' : 'Play'}
      </button>
      <button
        type="button"
        className="btn"
        aria-label="Next event"
        title="Next event"
        disabled={cursor >= range.to}
        onClick={() => actions.step(1)}
      >
        ▶︎
      </button>
      <div className="replay-speeds" role="group" aria-label="Speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className="btn btn-ghost"
            aria-pressed={speed === s}
            onClick={() => actions.setSpeed(s)}
          >
            {s}x
          </button>
        ))}
      </div>
      <input
        className="replay-scrubber"
        type="range"
        aria-label="Moment in the log"
        min={range.from}
        max={range.to}
        step={1}
        value={cursor}
        disabled={empty}
        onChange={(event) => actions.seek(Number(event.target.value))}
      />
      <span className="replay-position" aria-live="off">
        {positionLabel(events, cursor, time)}
      </span>
      <select
        aria-label="Narrow to a mission or an employee"
        value={filterValue}
        disabled={empty}
        onChange={(event) => {
          const [kind, ...rest] = event.target.value.split(':')
          const id = rest.join(':')
          actions.setFilter(kind === 'mission' || kind === 'employee' ? { kind, id } : null)
        }}
      >
        <option value="">Everything</option>
        {missions.length > 0 && (
          <optgroup label="Missions">
            {missions.map(({ mission }) => (
              <option key={mission.id} value={`mission:${mission.id}`}>
                {mission.title}
              </option>
            ))}
          </optgroup>
        )}
        {employees.length > 0 && (
          <optgroup label="Employees">
            {employees.map((employee) => (
              <option key={employee.id} value={`employee:${employee.id}`}>
                {employee.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {filter && (
        <>
          <button
            type="button"
            className="btn"
            disabled={matches.length === 0}
            onClick={() => actions.stepMatch(-1)}
            title="The previous event about it"
          >
            Previous match
          </button>
          <button
            type="button"
            className="btn"
            disabled={matches.length === 0}
            onClick={() => actions.stepMatch(1)}
            title="The next event about it"
          >
            Next match
          </button>
          <span className="muted">
            {matches.length === 0 ? 'Nothing recorded about it' : `${matches.length} events`}
          </span>
        </>
      )}
      <button type="button" className="btn replay-live" onClick={actions.exit}>
        Back to live
      </button>
    </div>
  )
}
