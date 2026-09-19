import { useState } from 'react'
import type { Mission, Task } from '@shared/missions'
import { MISSION_STATUS_LABELS } from '../missions/labels'
import { selectedMission, useMissions } from '../store/missions'
import { useOffice } from '../store/office'
import { MissionDialog } from './MissionDialog'
import { TaskDetail } from './TaskDetail'
import { TaskDialog } from './TaskDialog'
import { TaskGraph } from './TaskGraph'

/** Missions: what the team is working toward, as a graph of tasks with dependencies. */
export function MissionsPanel() {
  const missions = useMissions((s) => s.missions)
  const current = useMissions(selectedMission)
  const selectedTaskId = useMissions((s) => s.selectedTaskId)
  const selectMission = useMissions((s) => s.selectMission)
  const selectTask = useMissions((s) => s.selectTask)
  const missionAction = useMissions((s) => s.missionAction)
  const archiveMission = useMissions((s) => s.archiveMission)
  const employees = useOffice((s) => s.employees)

  const [missionDialog, setMissionDialog] = useState<{ open: boolean; editing: Mission | null }>({
    open: false,
    editing: null,
  })
  const [taskDialog, setTaskDialog] = useState<{ open: boolean; editing: Task | null }>({
    open: false,
    editing: null,
  })
  const [error, setError] = useState<string | null>(null)

  const names = Object.fromEntries(employees.map((e) => [e.id, e.name]))
  const mission = current?.mission
  const tasks = current?.tasks ?? []
  const task = tasks.find((t) => t.id === selectedTaskId)
  const open = mission && mission.status !== 'completed' && mission.status !== 'cancelled'

  async function act(work: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    setError(null)
    const outcome = await work()
    if (!outcome.ok) setError(outcome.error ?? 'That did not work')
  }

  const closeMissionDialog = (): void => setMissionDialog((d) => ({ ...d, open: false }))
  const closeTaskDialog = (): void => setTaskDialog((d) => ({ ...d, open: false }))

  return (
    <section className="panel missions" aria-label="Missions">
      <div className="panel-head">
        {missions.length > 0 ? (
          <select
            className="mission-select"
            aria-label="Mission"
            value={mission?.id ?? ''}
            onChange={(e) => selectMission(e.target.value)}
          >
            {missions.map(({ mission: m }) => (
              <option key={m.id} value={m.id}>
                {m.title} — {MISSION_STATUS_LABELS[m.status]}
              </option>
            ))}
          </select>
        ) : (
          <h2>Missions</h2>
        )}
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setMissionDialog({ open: true, editing: null })}
        >
          + New mission
        </button>
      </div>

      {!mission ? (
        <div className="empty">
          <p>
            <strong>No missions yet.</strong>
          </p>
          <p className="muted">
            A mission is a goal, broken into tasks. Give tasks to employees and say which must
            finish before others start. When you run the mission, ready tasks are sent to their
            employee as soon as they are idle — and when an employee says a task is finished, you
            decide whether to accept it.
          </p>
        </div>
      ) : (
        <>
          <div className="mission-bar">
            <span className="mission-pill" data-status={mission.status}>
              {MISSION_STATUS_LABELS[mission.status]}
            </span>
            <div className="row">
              {(mission.status === 'draft' || mission.status === 'paused') && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void act(() => missionAction(mission.id, 'run'))}
                >
                  {mission.status === 'paused' ? 'Resume' : 'Run mission'}
                </button>
              )}
              {mission.status === 'running' && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void act(() => missionAction(mission.id, 'pause'))}
                >
                  Pause
                </button>
              )}
              {open && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setMissionDialog({ open: true, editing: mission })}
                >
                  Edit
                </button>
              )}
              {open && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Cancel this mission? Every task that is not finished will be cancelled.',
                      )
                    ) {
                      void act(() => missionAction(mission.id, 'cancel'))
                    }
                  }}
                >
                  Cancel
                </button>
              )}
              {!open && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void act(() => archiveMission(mission.id))}
                >
                  Archive
                </button>
              )}
            </div>
          </div>

          {mission.description && (
            <p className="muted mission-description">{mission.description}</p>
          )}
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}

          <div className="task-toolbar">
            <h3>Tasks</h3>
            {open && (
              <button
                type="button"
                className="btn"
                onClick={() => setTaskDialog({ open: true, editing: null })}
              >
                + Add task
              </button>
            )}
          </div>

          {tasks.length === 0 ? (
            <p className="muted">No tasks yet. Add the first step.</p>
          ) : (
            <TaskGraph
              tasks={tasks}
              names={names}
              selectedId={selectedTaskId}
              onSelect={selectTask}
            />
          )}

          {task ? (
            <TaskDetail
              key={task.id}
              task={task}
              mission={mission}
              tasks={tasks}
              onEdit={() => setTaskDialog({ open: true, editing: task })}
            />
          ) : (
            tasks.length > 0 && (
              <p className="muted">Select a task to see it, review it, or send it back.</p>
            )
          )}

          <MissionDialog
            open={missionDialog.open}
            editing={missionDialog.editing}
            onClose={closeMissionDialog}
          />
          <TaskDialog
            open={taskDialog.open}
            missionId={mission.id}
            tasks={tasks}
            editing={taskDialog.editing}
            onClose={closeTaskDialog}
          />
        </>
      )}

      {!mission && (
        <MissionDialog
          open={missionDialog.open}
          editing={missionDialog.editing}
          onClose={closeMissionDialog}
        />
      )}
    </section>
  )
}
