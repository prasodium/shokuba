import { useEffect, useMemo, useRef, useState } from 'react'
import { ZOOM_STEP } from '../office/camera'
import { flightFor } from '../office/handoffs'
import { readLifeSetting, writeLifeSetting } from '../office/lifeSetting'
import { MAX_VISIBLE_EMPLOYEES } from '../office/map'
import { OfficeScene, type CameraState, type SceneEmployee } from '../office/scene'
import { onLiveEvent } from '../store/live'
import { useMissions } from '../store/missions'
import { useOffice } from '../store/office'
import { useOfficeSignals } from '../store/work'

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
export function OfficeView({ onNew }: { onNew(): void }) {
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

  const employees = useOffice((s) => s.employees)
  const views = useOffice((s) => s.views)
  const selectedId = useOffice((s) => s.selectedId)
  const select = useOffice((s) => s.select)
  const signals = useOfficeSignals()

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
        isManager: e.isManager,
        reportsTo: e.reportsTo,
      })),
    [employees],
  )

  useEffect(() => scene?.setEmployees(sceneEmployees), [scene, sceneEmployees])
  useEffect(() => scene?.setViews(views), [scene, views])
  useEffect(() => scene?.setSelected(selectedId), [scene, selectedId])
  useEffect(() => scene?.setSignals(signals), [scene, signals])
  useEffect(() => scene?.setLife(life), [scene, life])

  // Work changing hands is drawn as it happens. Only news counts: opening the office never replays
  // what was recorded before.
  useEffect(() => {
    if (!scene) return
    return onLiveEvent((event) => {
      const flight = flightFor(event, {
        assigneeOf: (taskId) =>
          useMissions
            .getState()
            .missions.flatMap((detail) => detail.tasks)
            .find((task) => task.id === taskId)?.assigneeId ?? null,
      })
      if (flight) scene.fly(flight)
    })
  }, [scene])

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
            aria-pressed={life && !reducedMotion}
            title={
              reducedMotion
                ? 'Off, because your system asks for reduced motion: nobody walks.'
                : 'Employees take tea and snack breaks while their agent is idle. This is simulated, it is marked as simulated, and nothing is ever sent to an agent.'
            }
            disabled={!scene || reducedMotion}
            onClick={() => {
              writeLifeSetting(browserStorage(), !life)
              setLife(!life)
            }}
          >
            Office life
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
      {!failure && employees.length === 0 && (
        <div className="office-overlay office-overlay-soft">
          <p>
            <strong>The office is empty.</strong>
          </p>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            Hire your first employee
          </button>
        </div>
      )}
      {overflow > 0 && (
        <p className="office-note">
          +{overflow} more not shown yet (the office has {MAX_VISIBLE_EMPLOYEES} desks)
        </p>
      )}
    </div>
  )
}
