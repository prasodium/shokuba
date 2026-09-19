import { z } from 'zod'
import type { EventSource } from '@shared/events/schema'
import { MissionError, type MissionService } from '../missions/service'
import { defineTool, McpToolError, type McpTool } from './server'

/** The name agents see Shokuba under; tools appear as `mcp__shokuba__<tool>`. */
export const SHOKUBA_MCP_SERVER = 'shokuba'
export const AGENT_TOOL_NAMES = ['get_current_task', 'submit_task', 'report_blocked'] as const

/** Full names, as Claude Code's permission rules refer to them. */
export const AGENT_TOOL_PERMISSIONS = AGENT_TOOL_NAMES.map(
  (name) => `mcp__${SHOKUBA_MCP_SERVER}__${name}`,
)

export const SHOKUBA_MCP_INSTRUCTIONS =
  'Shokuba coordinates a team of agents. Tasks arrive as a message starting "[Shokuba task]". ' +
  'Report back with submit_task when finished, or report_blocked if you cannot continue.'

/** Who is calling. Set by Shokuba from the connection, never from anything the agent sends. */
export interface AgentToolContext {
  employeeId: string
  /** How events from this agent are labelled (`simulated` for the demo agent). */
  source: Extract<EventSource, 'reported' | 'simulated'>
}

const optionalTaskId = z
  .string()
  .max(200)
  .optional()
  .describe('The task id from the briefing. Optional: defaults to the task you are working on.')

/** Turn a rule violation into something the model can read and act on. */
function explain<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof MissionError) throw new McpToolError(error.message)
    throw error
  }
}

/**
 * What an agent may do to Shokuba: read its own task, and say it is finished or stuck.
 * These tools only ever write to Shokuba's own records — they cannot run commands, read
 * files, or touch another agent's task. Saying "finished" makes a task `submitted`, which
 * a person must still accept.
 */
export function createAgentTools(missions: MissionService): McpTool<AgentToolContext>[] {
  return [
    defineTool<AgentToolContext, z.ZodObject<Record<string, never>>>({
      name: 'get_current_task',
      description:
        'Returns the task Shokuba handed you (what to do, feedback, and what teammates finished). Use it if you need the details again.',
      input: z.object({}),
      handler: (_args, ctx) => {
        const task = missions.currentTaskFor(ctx.employeeId)
        return task ? missions.briefing(task.id) : 'You have no task in progress.'
      },
    }),

    defineTool({
      name: 'submit_task',
      description:
        'Tell Shokuba you have finished the task you were handed. Give a short, honest summary of what you did and how you checked it. A person reviews it; do not start other work until told.',
      input: z.object({
        taskId: optionalTaskId,
        summary: z.string().min(1).max(4000).describe('What you did and how you verified it.'),
      }),
      handler: (args, ctx) =>
        explain(() => {
          const task = missions.agentSubmit(
            ctx.employeeId,
            { taskId: args.taskId, summary: args.summary },
            { source: ctx.source },
          )
          return `Submitted "${task.title}". It is now waiting for a person to review it.`
        }),
    }),

    defineTool({
      name: 'report_blocked',
      description:
        'Tell Shokuba you cannot continue the task you were handed, and why (missing access, unclear requirement, a failing dependency...).',
      input: z.object({
        taskId: optionalTaskId,
        reason: z.string().min(1).max(4000).describe('What is stopping you.'),
      }),
      handler: (args, ctx) =>
        explain(() => {
          const task = missions.agentBlocked(
            ctx.employeeId,
            { taskId: args.taskId, reason: args.reason },
            { source: ctx.source },
          )
          return `Marked "${task.title}" as blocked. A person will decide what happens next.`
        }),
    }),
  ]
}
