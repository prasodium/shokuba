import { z } from 'zod'
import type { EventSource } from '@shared/events/schema'
import type { Task } from '@shared/missions'
import { HUMAN, MESSAGE_KINDS } from '@shared/messages'
import { MessageError, type MessageService } from '../messages/service'
import { ManagerPlanning } from '../missions/planning'
import { MissionError, type MissionService } from '../missions/service'
import { ReviewError } from '../reviews/service'
import { ReviewSubmitSchema, type Review, type ReviewSubmit } from '@shared/reviews'
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

/** Tools only a manager is offered: drafting work for their team, and seeing how it is going. */
export const MANAGER_TOOL_NAMES = [
  'draft_mission',
  'add_task',
  'remove_task',
  'get_draft',
  'team_status',
] as const

/** Tools only someone who is reading a review is offered: seeing it again, and handing it in. */
export const REVIEW_TOOL_NAMES = ['get_current_review', 'submit_review'] as const

/**
 * The tools an agent may always use, even paused: they are how it hands work back to a person.
 * Everything else can be denied by the circuit breaker.
 */
export const HAND_BACK_TOOLS: ReadonlySet<string> = new Set(
  ['get_current_task', 'submit_task', 'report_blocked', ...REVIEW_TOOL_NAMES].map(
    (name) => `mcp__shokuba__${name}`,
  ),
)

/** Full names, as Claude Code's permission rules refer to them. */
export const AGENT_TOOL_PERMISSIONS = AGENT_TOOL_NAMES.map(
  (name) => `mcp__${SHOKUBA_MCP_SERVER}__${name}`,
)

/** A manager's tools too, pre-approved so drafting a plan never stops at a permission prompt. */
export const MANAGER_TOOL_PERMISSIONS = MANAGER_TOOL_NAMES.map(
  (name) => `mcp__${SHOKUBA_MCP_SERVER}__${name}`,
)

/**
 * Pre-approved for everyone, since anyone may be asked to review; the tools are hidden from, and
 * refused to, anyone who is not reading a review at that moment.
 */
export const REVIEW_TOOL_PERMISSIONS = REVIEW_TOOL_NAMES.map(
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
    if (
      error instanceof MissionError ||
      error instanceof MessageError ||
      error instanceof ReviewError
    ) {
      throw new McpToolError(error.message)
    }
    throw error
  }
}

/** One employee, as an agent's tools see them. */
export interface TeamMember {
  id: string
  name: string
  role: string
  isManager?: boolean
  /** The manager this employee reports to. */
  reportsTo?: string | null
}

/** Who is on the team, for `list_teammates`. */
export interface Team {
  list(): TeamMember[]
  isRunning(employeeId: string): boolean
  /** Why this agent may not send messages right now (the circuit breaker), or null if it may. */
  messageBlocker?(employeeId: string): string | null
}

/** The manager an employee reports to, if they have one. */
function managerOf(team: Team, employeeId: string): TeamMember | undefined {
  const everyone = team.list()
  const reportsTo = everyone.find((member) => member.id === employeeId)?.reportsTo
  return reportsTo ? everyone.find((member) => member.id === reportsTo) : undefined
}

/**
 * What an agent may do to Shokuba: read its own task, say it is finished or stuck, see who is
 * on the team, and message them (or the person). These tools only ever write Shokuba's own
 * records — they cannot run commands, read files, or touch another agent's task. Saying
 * "finished" makes a task `submitted`, which a person must still accept; and what an agent
 * sends while answering a message counts as a reply, so a runaway exchange is stopped.
 */
/** Things that should happen because an agent used a tool, kept out of the tools themselves. */
/** What the review tools need from the review service. */
export interface ReviewsPort {
  hasActive(employeeId: string): boolean
  current(employeeId: string): Promise<string | null>
  submit(employeeId: string, input: ReviewSubmit): Review
}

export interface AgentToolHooks {
  /** Present when reviews are available; the review tools are offered only while one is being read. */
  reviews?: ReviewsPort
  /**
   * An agent is about to submit a task: save its work first, so that by the time the task shows
   * as submitted the work already exists. A failure here never fails the tool.
   */
  beforeSubmit?(task: Task): Promise<void> | void
}

export function createAgentTools(
  missions: MissionService,
  messages: MessageService,
  team: Team,
  hooks: AgentToolHooks = {},
): McpTool<AgentToolContext>[] {
  const planning = new ManagerPlanning(missions, team)
  const managerOnly = (ctx: AgentToolContext): boolean => planning.isManager(ctx.employeeId)
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
      handler: async (args, ctx) => {
        // Save the work before the task flips to "submitted", so nobody looking at it in between
        // sees a submitted task whose changes are not there yet.
        const target = args.taskId
          ? missions.getTask(args.taskId)
          : missions.currentTaskFor(ctx.employeeId)
        if (target && target.assigneeId === ctx.employeeId) {
          try {
            await hooks.beforeSubmit?.(target)
          } catch {
            // Submitting goes ahead either way; saving the work must never stop it.
          }
        }
        const task = explain(() =>
          missions.agentSubmit(
            ctx.employeeId,
            { taskId: args.taskId, summary: args.summary },
            { source: ctx.source },
          ),
        )
        return `Submitted "${task.title}". It is now waiting for a person to review it.`
      },
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
          // Whoever leads this employee should hear it too, so they can help, or take it further.
          const manager = managerOf(team, ctx.employeeId)
          let told = false
          if (manager) {
            try {
              told =
                messages.sendFromAgent(
                  ctx.employeeId,
                  {
                    to: manager.id,
                    kind: 'warning',
                    subject: `Blocked: ${task.title}`.slice(0, 120),
                    body: args.reason,
                    taskId: task.id,
                  },
                  { source: ctx.source, employeeId: ctx.employeeId },
                ).state !== 'held'
            } catch {
              // The task is blocked either way; a message that cannot be sent must not undo that.
            }
          }
          return told && manager
            ? `Marked "${task.title}" as blocked. ${manager.name}, your manager, has been told, and a person will decide what happens next.`
            : `Marked "${task.title}" as blocked. A person will decide what happens next.`
        }),
    }),

    defineTool<AgentToolContext, z.ZodObject<Record<string, never>>>({
      name: 'list_teammates',
      description:
        'Lists your teammates (name, role, id, whether they are running) and how the team is organised: who your manager is, or who reports to you. ' +
        'Use a name or id as "to" in send_message. If you report to a manager, they are how you reach the person you work for.',
      input: z.object({}),
      handler: (_args, ctx) => {
        const everyone = team.list()
        const me = everyone.find((member) => member.id === ctx.employeeId)
        const manager = managerOf(team, ctx.employeeId)
        const lines = everyone
          .filter((member) => member.id !== ctx.employeeId)
          .map((member) => {
            const note =
              member.id === manager?.id
                ? ' — your manager'
                : member.reportsTo === ctx.employeeId
                  ? ' — reports to you'
                  : member.isManager
                    ? ' — a manager'
                    : ''
            return `- ${member.name} (${member.role})${note} — id ${member.id} — ${team.isRunning(member.id) ? 'running' : 'not running'}`
          })
        return [
          `Teammates:`,
          ...(lines.length > 0 ? lines : ['(nobody else is here)']),
          manager
            ? `You report to ${manager.name}, so you do not message the person you work for directly. If you need something from them, ask ${manager.name}.`
            : `- the person you work for — to: "${HUMAN}"${me?.isManager ? ' (you are the one who talks to them for your team)' : ''}`,
        ].join('\n')
      },
    }),

    defineTool({
      name: 'send_message',
      description:
        'Send a message to a teammate, or to the person you work for (to: "human"). If you report to a manager, you cannot message the person directly: send it to your manager instead, and they will take it to the person if it needs to go further. ' +
        'Use it when they need something from you or you need something from them. ' +
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
          // A constrained agent may still ask whoever it answers to for help (its manager, or
          // the person if it has none), but not talk to teammates.
          const manager = managerOf(team, ctx.employeeId)
          const to = args.to.trim().toLowerCase()
          const goesUp = manager
            ? to === manager.id.toLowerCase() || to === manager.name.toLowerCase()
            : to === HUMAN
          const blocker = goesUp ? null : team.messageBlocker?.(ctx.employeeId)
          if (blocker) throw new McpToolError(blocker)
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

    // ---------- a manager's tools ----------

    defineTool({
      name: 'draft_mission',
      description:
        'Start a draft mission for your team. A draft does nothing by itself: the person reviews it and presses Run mission, and only then are its tasks handed out. ' +
        'After this, use add_task for each piece of work, then tell the person (send_message to "human") that the draft is ready for them.',
      input: z.object({
        title: z.string().min(1).max(120).describe('A short single-line title.'),
        description: z.string().max(4000).optional().describe('What the mission is for.'),
        priority: z.enum(['low', 'normal', 'high']).optional(),
      }),
      visibleTo: managerOnly,
      handler: (args, ctx) =>
        explain(() => {
          const mission = planning.draftMission(ctx.employeeId, args, ctx.source)
          return `Drafted "${mission.title}" (id ${mission.id}). It is only a draft: nothing is sent until the person runs it. Add its tasks with add_task.`
        }),
    }),

    defineTool({
      name: 'add_task',
      description:
        'Add a task to one of your drafts. Assign it to yourself or to someone who reports to you. ' +
        'dependsOn lists tasks in this draft that must finish first, by id or exact title. You can only add to a draft you wrote that the person has not yet run.',
      input: z.object({
        missionId: z
          .string()
          .min(1)
          .max(200)
          .describe('The draft, from draft_mission or get_draft.'),
        title: z.string().min(1).max(160).describe('A short single-line title.'),
        description: z
          .string()
          .max(8000)
          .optional()
          .describe('What to do and how to know it is done. The assignee reads this.'),
        assignee: z
          .string()
          .max(200)
          .optional()
          .describe('A name or id of someone on your team, or yourself.'),
        dependsOn: z.array(z.string().min(1).max(200)).max(50).optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
      }),
      visibleTo: managerOnly,
      handler: (args, ctx) =>
        explain(() => {
          const { task, assigneeName, waitsFor } = planning.addTask(
            ctx.employeeId,
            args,
            ctx.source,
          )
          return (
            `Added "${task.title}" (id ${task.id})` +
            (assigneeName ? `, assigned to ${assigneeName}` : ', not assigned to anyone yet') +
            (waitsFor.length > 0 ? `, after ${waitsFor.map((t) => `"${t}"`).join(' and ')}` : '') +
            '.'
          )
        }),
    }),

    defineTool({
      name: 'remove_task',
      description: 'Remove a task from one of your drafts, for example one you added by mistake.',
      input: z.object({ taskId: z.string().min(1).max(200) }),
      visibleTo: managerOnly,
      handler: (args, ctx) =>
        explain(() => {
          const task = planning.removeTask(ctx.employeeId, args.taskId, ctx.source)
          return `Removed "${task.title}" from the draft.`
        }),
    }),

    defineTool({
      name: 'get_draft',
      description:
        'Shows one of your drafts with its tasks, who each is assigned to and what each waits for. Without a missionId, lists your open drafts. Use it to check your plan before telling the person.',
      input: z.object({ missionId: z.string().min(1).max(200).optional() }),
      visibleTo: managerOnly,
      handler: (args, ctx) => explain(() => planning.describeDraft(ctx.employeeId, args.missionId)),
    }),

    defineTool<AgentToolContext, z.ZodObject<Record<string, never>>>({
      name: 'team_status',
      description:
        'Shows the people who report to you: whether each is running and what task they are on.',
      input: z.object({}),
      visibleTo: managerOnly,
      handler: (_args, ctx) => explain(() => planning.teamStatus(ctx.employeeId)),
    }),

    // ---------- a reviewer's tools ----------

    defineTool<AgentToolContext, z.ZodObject<Record<string, never>>>({
      name: 'get_current_review',
      description:
        'Shows the review you were asked to do again: what was asked for, where the code is, and the change. Only available while you are reviewing something.',
      input: z.object({}),
      visibleTo: (ctx) => hooks.reviews?.hasActive(ctx.employeeId) === true,
      handler: async (_args, ctx) =>
        (await hooks.reviews?.current(ctx.employeeId)) ?? 'You have no review in progress.',
    }),

    defineTool({
      name: 'submit_review',
      description:
        'Hand in your review of the work you were asked to read. Give a verdict (approve, request_changes or comment), a short summary, and your findings: each with a severity (blocker, major, minor or nit), the file and line if you can, and what is wrong. Report only what you actually found. A person reads it and decides; it does not accept or reject anything by itself.',
      input: ReviewSubmitSchema,
      visibleTo: (ctx) => hooks.reviews?.hasActive(ctx.employeeId) === true,
      handler: (args, ctx) =>
        explain(() => {
          if (!hooks.reviews) throw new McpToolError('Reviews are not available.')
          const review = hooks.reviews.submit(ctx.employeeId, args)
          const count = review.findings.length
          return `Review handed in: ${review.verdict?.replace('_', ' ')}, with ${count} finding${count === 1 ? '' : 's'}. A person will read it. You are done; do not change anything.`
        }),
    }),
  ]
}
