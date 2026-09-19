import { z } from 'zod'
import type { EventSource } from '@shared/events/schema'
import { HUMAN, MESSAGE_KINDS } from '@shared/messages'
import { MessageError, type MessageService } from '../messages/service'
import { MissionError, type MissionService } from '../missions/service'
import { defineTool, McpToolError, type McpTool } from './server'

/** The name agents see Shokuba under; tools appear as `mcp__shokuba__<tool>`. */
export const SHOKUBA_MCP_SERVER = 'shokuba'
export const AGENT_TOOL_NAMES = [
  'get_current_task',
  'submit_task',
  'report_blocked',
  'list_teammates',
  'send_message',
] as const

/** Full names, as Claude Code's permission rules refer to them. */
export const AGENT_TOOL_PERMISSIONS = AGENT_TOOL_NAMES.map(
  (name) => `mcp__${SHOKUBA_MCP_SERVER}__${name}`,
)

export const SHOKUBA_MCP_INSTRUCTIONS =
  'Shokuba coordinates a team of agents. Tasks arrive as a message starting "[Shokuba task]"; ' +
  'report back with submit_task when finished, or report_blocked if you cannot continue. ' +
  'Messages from teammates start "[Shokuba message]"; use send_message to reply.'

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
    if (error instanceof MissionError || error instanceof MessageError) {
      throw new McpToolError(error.message)
    }
    throw error
  }
}

/** Who is on the team, for `list_teammates`. */
export interface Team {
  list(): Array<{ id: string; name: string; role: string }>
  isRunning(employeeId: string): boolean
}

/**
 * What an agent may do to Shokuba: read its own task, say it is finished or stuck, see who is
 * on the team, and message them (or the person). These tools only ever write Shokuba's own
 * records — they cannot run commands, read files, or touch another agent's task. Saying
 * "finished" makes a task `submitted`, which a person must still accept; and what an agent
 * sends while answering a message counts as a reply, so a runaway exchange is stopped.
 */
export function createAgentTools(
  missions: MissionService,
  messages: MessageService,
  team: Team,
): McpTool<AgentToolContext>[] {
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

    defineTool<AgentToolContext, z.ZodObject<Record<string, never>>>({
      name: 'list_teammates',
      description:
        'Lists your teammates (name, role, id, whether they are running). Use a name or id as "to" in send_message. The person you work for is always reachable as "human".',
      input: z.object({}),
      handler: (_args, ctx) => {
        const lines = team
          .list()
          .filter((employee) => employee.id !== ctx.employeeId)
          .map(
            (employee) =>
              `- ${employee.name} (${employee.role}) — id ${employee.id} — ${team.isRunning(employee.id) ? 'running' : 'not running'}`,
          )
        return [
          `Teammates:`,
          ...(lines.length > 0 ? lines : ['(nobody else is here)']),
          `- the person you work for — to: "${HUMAN}"`,
        ].join('\n')
      },
    }),

    defineTool({
      name: 'send_message',
      description:
        'Send a message to a teammate, or to the person you work for (to: "human"). Use it when they need something from you or you need something from them. ' +
        'Do not reply just to acknowledge, and do not chat: conversations that go back and forth many times are stopped and a person is alerted. The message reaches them when they finish their current turn.',
      input: z.object({
        to: z
          .string()
          .min(1)
          .max(200)
          .describe('A teammate name or id from list_teammates, or "human".'),
        kind: z
          .enum(MESSAGE_KINDS)
          .default('inform')
          .describe(
            'What sort of message: request, inform, question, handoff, review, approval, warning or completion.',
          ),
        subject: z.string().min(1).max(120).describe('A short single-line subject.'),
        body: z.string().min(1).max(4000).describe('The message itself.'),
        taskId: z.string().max(200).optional().describe('The task this is about, if any.'),
      }),
      handler: (args, ctx) =>
        explain(() => {
          const message = messages.sendFromAgent(
            ctx.employeeId,
            {
              to: args.to,
              kind: args.kind,
              subject: args.subject,
              body: args.body,
              ...(args.taskId && { taskId: args.taskId }),
            },
            { source: ctx.source, employeeId: ctx.employeeId },
          )
          if (message.state === 'held') {
            throw new McpToolError(
              `Not delivered: ${message.heldReason}. A person has been told. Do not send more in this conversation.`,
            )
          }
          return message.toId === HUMAN
            ? 'Sent to the person you work for. Do not wait for a reply; carry on.'
            : 'Sent. They will see it when their current turn ends. Do not wait for a reply; carry on.'
        }),
    }),
  ]
}
