import { useEffect, useMemo, useRef, useState } from 'react'
import { ZOOM_STEP } from '../office/camera'
import { flightFor } from '../office/handoffs'
import { readLifeSetting, writeLifeSetting } from '../office/lifeSetting'
import { MAX_VISIBLE_EMPLOYEES } from '../office/map'
import { OfficeScene, type CameraState, type SceneEmployee } from '../office/scene'
import { styleOf } from '../office/style'
import { notesFor } from '../office/talk'
import { EMPTY_SIGNALS } from '../office/work'
import { presentAt, removedSince, subjectAt } from '../replay/labels'
import { useDepartments } from '../store/departments'
import { useEvents } from '../store/events'
import { onLiveEvent } from '../store/live'
import { useMessages } from '../store/messages'
import { useMissions } from '../store/missions'
import { useOffice } from '../store/office'
import { useOfficeSettings } from '../store/officeSettings'
import { onReplayEvent, useReplaying, useShownViews, useTimeline } from '../store/timeline'
import { useOfficeSignals } from '../store/work'

/**
 * The subject of a conversation, as recorded: from its `conversation.created` event if that is
 * still among the events the window keeps, otherwise from the conversations it has loaded.
 */
function subjectOfConversation(conversationId: string): string | null {
  const events = useEvents.getState().events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'conversation.created' && event.payload.conversationId === conversationId) {
      return event.payload.subject
    }
  }
  const known = useMessages
    .getState()
    .conversations.find((c) => c.conversation.id === conversationId)
  return known?.conversation.subject ?? null
}

/** This window's own store, or nothing if the browser will not give it out. */
function browserStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/**
 * The isometric voxel office. It only *displays* what the event stream says, with one labelled
 * exception: simulated office life (tea and snack breaks while an agent is idle), which has its own
 * switch.
 */
export function OfficeView({ onNew, onCustomise }: { onNew(): void; onCustomise(): void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [scene, setScene] = useState<OfficeScene | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [camera, setCamera] = useState<CameraState | null>(null)
  const [life, setLife] = useState(() => readLifeSetting(browserStorage()))
  // With the system's reduced-motion setting nobody walks, so there is no office life to switch.
  const reducedMotion = useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  const allEmployees = useOffice((s) => s.employees)
  // One time source: the present, or the replay cursor.
  const replaying = useReplaying()
  const views = useShownViews()
  // In replay, only who was hired by then; the board, the inbox and the bench come from today's
  // missions, which events cannot rebuild, so replay leaves them empty rather than show the present.
  const employees = useMemo(
    () => (replaying ? presentAt(allEmployees, views) : allEmployees),
    [replaying, allEmployees, views],
  )
  const removed = replaying ? removedSince(allEmployees, views) : 0
  const selectedId = useOffice((s) => s.selectedId)
  const select = useOffice((s) => s.select)
  const liveSignals = useOfficeSignals()
  const signals = replaying ? EMPTY_SIGNALS : liveSignals

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let created: OfficeScene | undefined

    OfficeScene.create(host, { onSelect: (id) => select(id), onCamera: setCamera })
      .then((made) => {
        if (cancelled) {
          made.destroy()
          return
        }
        created = made
        setScene(made)
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error))
      })

    return () => {
      cancelled = true
      created?.destroy()
      setScene(null)
    }
  }, [select])

  const sceneEmployees = useMemo<SceneEmployee[]>(
    () =>
      employees.map((e) => ({
        id: e.id,
        name: e.name,
        role: e.role,
        color: e.color,
        appearance: e.appearance,
        departmentId: e.departmentId,
        isManager: e.isManager,
        reportsTo: e.reportsTo,
      })),
    [employees],
  )

  const settings = useOfficeSettings((s) => s.settings)
  const style = useMemo(() => styleOf(settings), [settings])
  useEffect(() => scene?.setStyle(style), [scene, style])

  const departments = useDepartments((s) => s.departments)
  // The departments first, so the seating knows them when the employees arrive.
  useEffect(() => scene?.setDepartments(departments), [scene, departments])
  useEffect(() => scene?.setEmployees(sceneEmployees), [scene, sceneEmployees])
  useEffect(() => scene?.setViews(views), [scene, views])
  useEffect(() => scene?.setSelected(selectedId), [scene, selectedId])
  useEffect(() => scene?.setSignals(signals), [scene, signals])
  // Simulated office life is never part of a replay: it shows only what was recorded.
  useEffect(() => scene?.setLife(life && !replaying), [scene, life, replaying])

  // Work changing hands is drawn as it happens. Only news counts: opening the office never replays
  // what was recorded before.
  useEffect(() => {
    if (!scene || replaying) return
    return onLiveEvent((event) => {
      const flight = flightFor(event, {
        assigneeOf: (taskId) =>
          useMissions
            .getState()
            .missions.flatMap((detail) => detail.tasks)
            .find((task) => task.id === taskId)?.assigneeId ?? null,
      })
      if (flight) scene.fly(flight)
      // A real message also shows its real subject over the people it is between.
      scene.say(
        notesFor(event, {
          subjectOf: subjectOfConversation,
          nameOf: (id) => useOffice.getState().employees.find((e) => e.id === id)?.name ?? null,
        }),
      )
    })
  }, [scene, replaying])

  // In replay, the events it plays are drawn the same way, asking only what was recorded by then.
  useEffect(() => {
    if (!scene || !replaying) return
    return onReplayEvent((event) => {
      const { state, events, cursor } = useTimeline.getState()
      const flight = flightFor(event, { assigneeOf: (taskId) => state.assignees[taskId] ?? null })
      if (flight) scene.fly(flight)
      scene.say(
        notesFor(event, {
          subjectOf: (conversationId) => subjectAt(events, cursor, conversationId),
          nameOf: (id) => useOffice.getState().employees.find((e) => e.id === id)?.name ?? null,
        }),
      )
    })
  }, [scene, replaying])

  const overflow = Math.max(0, employees.length - MAX_VISIBLE_EMPLOYEES)

  return (
    <div className="office">
      <div
        ref={hostRef}
        className="office-canvas"
        role="group"
        tabIndex={0}
        aria-label="Isometric office. Focus here, then use the arrow keys to move the view, plus and minus to zoom, 0 to show the whole office, and F to follow the selected employee."
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return
          if (scene?.handleKey(event.key)) event.preventDefault()
        }}
      />
      {!failure && style.title !== '' && <div className="office-title">{style.title}</div>}
      {!failure && (
        <div className="office-controls" role="toolbar" aria-label="Office view">
          <button
            type="button"
            className="office-control"
            aria-label="Zoom in"
            title="Zoom in (+)"
            disabled={!scene || camera?.canZoomIn === false}
            onClick={() => scene?.zoomBy(ZOOM_STEP)}
          >
            +
          </button>
          <button
            type="button"
            className="office-control"
            aria-label="Zoom out"
            title="Zoom out (−)"
            disabled={!scene || camera?.canZoomOut === false}
            onClick={() => scene?.zoomBy(1 / ZOOM_STEP)}
          >
            −
          </button>
          <button
            type="button"
            className="office-control"
            title="Show the whole office (0)"
            disabled={!scene || camera?.fitted !== false}
            onClick={() => scene?.fit()}
          >
            Fit
          </button>
          <button
            type="button"
            className="office-control"
            aria-pressed={camera?.following === true}
            title="Keep the selected employee in the middle (F)"
            disabled={!scene || selectedId === null}
            onClick={() => scene?.setFollow(camera?.following !== true)}
          >
            Follow
          </button>
          <button
            type="button"
            className="office-control"
            aria-pressed={life && !reducedMotion && !replaying}
            title={
              reducedMotion
                ? 'Off, because your system asks for reduced motion: nobody walks.'
                : replaying
                  ? 'Off during replay, which shows only what was recorded.'
                  : 'Employees take tea and snack breaks, chat at the pantry table and meet in the meeting room while their agent is idle. This is simulated, it is marked as simulated, and nothing is ever sent to an agent.'
            }
            disabled={!scene || reducedMotion || replaying}
            onClick={() => {
              writeLifeSetting(browserStorage(), !life)
              setLife(!life)
            }}
          >
            Office life
          </button>
          <button
            type="button"
            className="office-control"
            title={
              replaying
                ? 'Replay is read only. Go back to live to change the office.'
                : "Change the office's colours, names and decor"
            }
            disabled={!scene || replaying}
            onClick={onCustomise}
          >
            Customise
          </button>
        </div>
      )}
      {failure && (
        <div className="office-overlay">
          <p>
            <strong>The office view could not start.</strong>
          </p>
          <p className="muted">{failure}</p>
          <p className="muted">The roster and terminals still work.</p>
        </div>
      )}
      {!failure && replaying && employees.length === 0 && (
        <div className="office-overlay office-overlay-soft">
          <p>
            <strong>Nobody had been hired yet at this moment.</strong>
          </p>
        </div>
      )}
      {!failure && !replaying && employees.length === 0 && (
        <div className="office-overlay office-overlay-soft">
          <p>
            <strong>The office is empty.</strong>
          </p>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            Hire your first employee
          </button>
        </div>
      )}
      {removed > 0 && (
        <p className="office-note office-note-left">
          {removed} {removed === 1 ? 'person' : 'people'} who worked here then{' '}
          {removed === 1 ? 'has' : 'have'} since been removed, so cannot be drawn
        </p>
      )}
      {overflow > 0 && (
        <p className="office-note">
          +{overflow} more not shown yet (the office has {MAX_VISIBLE_EMPLOYEES} desks)
        </p>
      )}
    </div>
  )
}
