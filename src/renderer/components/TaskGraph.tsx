import { useMemo } from 'react'
import type { Task } from '@shared/missions'
import { layerize } from '@shared/missions/graph'
import { TASK_STATUS_LABELS, clip } from '../missions/labels'

const NODE_W = 162
const NODE_H = 58
const GAP_X = 34
const GAP_Y = 14
const PAD = 12

interface Props {
  tasks: readonly Task[]
  names: Readonly<Record<string, string>>
  selectedId: string | null
  onSelect(id: string): void
}

/**
 * The task graph, drawn left to right: a task sits one column after the furthest thing it
 * depends on, and an arrow runs from each dependency to the task that needs it.
 */
export function TaskGraph({ tasks, names, selectedId, onSelect }: Props) {
  const layout = useMemo(() => {
    const layers = layerize(tasks)
    const rows = new Map<number, number>()
    const spots = new Map<string, { x: number; y: number }>()
    for (const task of tasks) {
      const column = layers.get(task.id) ?? 0
      const row = rows.get(column) ?? 0
      rows.set(column, row + 1)
      spots.set(task.id, {
        x: PAD + column * (NODE_W + GAP_X),
        y: PAD + row * (NODE_H + GAP_Y),
      })
    }
    const columns = Math.max(0, ...layers.values()) + 1
    const tallest = Math.max(1, ...rows.values())
    return {
      spots,
      width: PAD * 2 + columns * NODE_W + (columns - 1) * GAP_X,
      height: PAD * 2 + tallest * NODE_H + (tallest - 1) * GAP_Y,
    }
  }, [tasks])

  if (tasks.length === 0) return null

  return (
    <div className="graph" role="group" aria-label="Task graph">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="edge-arrow" />
          </marker>
        </defs>

        {tasks.flatMap((task) =>
          task.dependsOn.map((dependencyId) => {
            const from = layout.spots.get(dependencyId)
            const to = layout.spots.get(task.id)
            if (!from || !to) return null
            const x1 = from.x + NODE_W
            const y1 = from.y + NODE_H / 2
            const x2 = to.x
            const y2 = to.y + NODE_H / 2
            const bend = Math.max(24, (x2 - x1) / 2)
            return (
              <path
                key={`${dependencyId}>${task.id}`}
                className="edge"
                d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 2} ${y2}`}
                markerEnd="url(#arrow)"
              />
            )
          }),
        )}

        {tasks.map((task) => {
          const spot = layout.spots.get(task.id)
          if (!spot) return null
          const who = task.assigneeId ? (names[task.assigneeId] ?? 'Removed') : 'Unassigned'
          return (
            <g
              key={task.id}
              className={`node ${task.id === selectedId ? 'is-selected' : ''}`}
              data-status={task.status}
              transform={`translate(${spot.x} ${spot.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${task.title}, ${TASK_STATUS_LABELS[task.status]}, ${who}`}
              aria-pressed={task.id === selectedId}
              onClick={() => onSelect(task.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(task.id)
                }
              }}
            >
              <rect className="node-box" width={NODE_W} height={NODE_H} rx={9} />
              <rect className="node-bar" width={5} height={NODE_H} rx={2.5} />
              <text className="node-title" x={16} y={23}>
                {clip(task.title, 21)}
              </text>
              <text className="node-sub" x={16} y={43}>
                {TASK_STATUS_LABELS[task.status]} · {clip(who, 11)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
