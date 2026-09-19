import { z } from 'zod'
import { hasControlCharacters } from './missions'

/** The id used for the person in `fromId` / `toId`. Employees have their own ids. */
export const HUMAN = 'human'

/**
 * A conversation is stopped when a chain of replies gets this long. Agents can answer each
 * other instantly and endlessly, so this is the guard against a runaway exchange; a person
 * decides whether to let it continue.
 */
export const MAX_HOPS = 6

/** Most messages that may wait for one recipient before senders are told to stop. */
export const MAX_QUEUED_PER_RECIPIENT = 20

export const MESSAGE_KINDS = [
  'request',
  'inform',
  'question',
  'handoff',
  'review',
  'approval',
  'warning',
  'completion',
] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

/**
 *  - queued:    waiting to be given to the recipient (an agent's turn must end, or it must be idle)
 *  - delivered: given to the agent (or, for a person, visible in their inbox)
 *  - held:      not delivered: the conversation hit the hop limit or was closed
 */
export const MESSAGE_STATES = ['queued', 'delivered', 'held'] as const
export type MessageState = (typeof MESSAGE_STATES)[number]

export const CONVERSATION_STATUSES = ['open', 'halted', 'closed'] as const
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]

const id = z.string().min(1).max(200)

const subject = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) => !hasControlCharacters(value, false),
    'must be a single line without control characters',
  )
const body = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .refine((value) => !hasControlCharacters(value, true), 'must not contain control characters')

/** A message the person writes in the app, to one employee. */
export const HumanMessageInputSchema = z.strictObject({
  toId: id,
  subject,
  body,
  kind: z.enum(MESSAGE_KINDS).default('inform'),
  /** Continue an existing conversation; omit to start a new one. */
  conversationId: id.nullable().default(null),
})
export type HumanMessageInput = z.input<typeof HumanMessageInputSchema>

export const CONVERSATION_ACTIONS = ['resume', 'close'] as const
export type ConversationAction = (typeof CONVERSATION_ACTIONS)[number]

export interface Message {
  id: string
  conversationId: string
  /** The message this one answers, worked out by Shokuba, never claimed by the sender. */
  parentId: string | null
  /** Position in the chain of replies, starting at 1. */
  hop: number
  fromId: string
  toId: string
  kind: MessageKind
  subject: string
  body: string
  taskId: string | null
  state: MessageState
  heldReason: string | null
  createdAt: string
  deliveredAt: string | null
  /** For messages to the person: when they opened it. */
  readAt: string | null
}

export interface Conversation {
  id: string
  subject: string
  status: ConversationStatus
  haltedReason: string | null
  missionId: string | null
  /** Hops before this are forgiven: a person resuming or writing resets the chain here. */
  hopBase: number
  createdAt: string
  updatedAt: string
}

export interface ConversationDetail {
  conversation: Conversation
  messages: Message[]
}
