import { useEffect, useMemo, useRef, useState } from 'react'
import { OfficeScene, type SceneEmployee } from '../office/scene'
import { MAX_VISIBLE_EMPLOYEES } from '../office/layout'
import { useOffice } from '../store/office'

/** The isometric voxel office. It only *displays* what the event stream says. */
export function OfficeView({ onNew }: { onNew(): void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [scene, setScene] = useState<OfficeScene | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const employees = useOffice((s) => s.employees)
  const views = useOffice((s) => s.views)
  const selectedId = useOffice((s) => s.selectedId)
  const select = useOffice((s) => s.select)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let created: OfficeScene | undefined

    OfficeScene.create(host, (id) => select(id))
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
    () => employees.map((e) => ({ id: e.id, name: e.name, role: e.role, color: e.color })),
    [employees],
  )

  useEffect(() => scene?.setEmployees(sceneEmployees), [scene, sceneEmployees])
  useEffect(() => scene?.setViews(views), [scene, views])
  useEffect(() => scene?.setSelected(selectedId), [scene, selectedId])

  const overflow = Math.max(0, employees.length - MAX_VISIBLE_EMPLOYEES)

  return (
    <div className="office">
      <div
        ref={hostRef}
        className="office-canvas"
        role="img"
        aria-label="Isometric office showing each employee at their desk"
      />
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
          +{overflow} more not shown yet (the office fits {MAX_VISIBLE_EMPLOYEES} desks)
        </p>
      )}
    </div>
  )
}
