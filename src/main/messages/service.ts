import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { EventInput, EventSource } from '@shared/events/schema'
import {
  HUMAN,
  HumanMessageInputSchema,
  MAX_HOPS,
  MAX_QUEUED_PER_RECIPIENT,
  MESSAGE_KINDS,
  type Conversation,
  type ConversationDetail,
  type ConversationStatus,
  type HumanMessageInput,
  type Message,
  type MessageKind,
  type MessageState,
} from '@shared/messages'
import { hasControlCharacters } from '@shared/missions'
import type { Db } from '../database/connection'
import type { EventStore } from '../events/store'
import { redactString } from '../security/redact'

export type MessageErrorCode =
  | 'invalid'
  | 'not-found'
  | 'unknown-recipient'
  | 'ambiguous'
  | 'self'
  | 'closed'
  | 'full'
  | 'state'
  | 'via-manager'

export class MessageError extends Error {
  constructor(
    readonly code: MessageErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MessageError'
  }
}

interface ConversationRow {
  id: string
  subject: string
  status: string
  halted_reason: string | null
  mission_id: string | null
  hop_base: number
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  conversation_id: string
  parent_id: string | null
  hop: number
  from_id: string
  to_id: string
  kind: string
  subject: string
  body: string
  task_id: string | null
  state: string
  held_reason: string | null
  created_at: string
  delivered_at: string | null
  read_at: string | null
}

/** What an agent sends. Content limits match a person's; `to` is an id, a unique name, or "human". */
const AgentMessageSchema = z.object({
  to: z.string().trim().min(1).max(200),
  kind: z.enum(MESSAGE_KINDS).default('inform'),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((v) => !hasControlCharacters(v, false), 'must be a single line'),
  body: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .refine((v) => !hasControlCharacters(v, true), 'must not contain control characters'),
  taskId: z.string().max(200).optional(),
})
export type AgentMessageArgs = z.input<typeof AgentMessageSchema>

export interface Directory {
  list(): Array<{
    id: string
    name: string
    role: string
    isManager?: boolean
    /** The manager this employee reports to. Someone who reports to a manager goes through them. */
    reportsTo?: string | null
  }>
}

export interface MessageServiceDeps {
  db: Db
  events: EventStore
  directory: Directory
  /** The mission a task belongs to, or undefined if there is no such task. */
  taskMissionId: (taskId: string) => string | undefined
  now?: () => Date
  newId?: () => string
}

export interface Actor {
  source: EventSource
  employeeId?: string
}

/** What an agent is answering right now: the message it was last given. */
interface Handling {
  messageId: string
  conversationId: string
  hop: number
}

/**
 * Messages, conversations and loop protection.
 *
 * The chain of replies is worked out here, not claimed by the sender: anything an agent sends
 * while it is handling a message it was given counts as a reply to that message, one hop
 * deeper. An agent cannot dodge the hop limit by leaving out a reference. When a chain passes
 * `MAX_HOPS`, the message is held and the conversation halted until a person resumes it. A
 * message from the person resets the chain.
 *
 * Message bodies are redacted before they are stored; events carry ids and metadata only.
 */
export class MessageService {
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly handling = new Map<string, Handling>()

  constructor(private readonly deps: MessageServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
  }

  // ---------- sending ----------

  /** A message an agent sent through its `send_message` tool. */
  sendFromAgent(fromId: string, raw: AgentMessageArgs, actor: Actor): Message {
    const parsed = AgentMessageSchema.safeParse(raw)
    if (!parsed.success) throw new MessageError('invalid', firstIssue(parsed.error))
    const args = parsed.data
    const recipient = this.resolveRecipient(args.to, fromId)
    if (recipient === HUMAN) this.requireToGoThroughManager(fromId)

    let missionId: string | null = null
    if (args.taskId !== undefined) {
      const found = this.deps.taskMissionId(args.taskId)
      if (found === undefined) throw new MessageError('invalid', 'There is no such task')
      missionId = found
    }

    return this.transact((out) => {
      const context = this.handling.get(fromId)
      const existing = context ? this.getConversation(context.conversationId) : undefined
      if (existing?.status === 'closed') {
        throw new MessageError('closed', 'A person closed that conversation. Do not continue it.')
      }
      const conversation = existing ?? this.createConversation(out, args.subject, missionId, actor)
      const hop = context && existing ? context.hop + 1 : 1
      const parentId = context && existing ? context.messageId : null

      if (recipient !== HUMAN && this.queuedCount(recipient) >= MAX_QUEUED_PER_RECIPIENT) {
        throw new MessageError(
          'full',
          'That teammate has too many unread messages. Wait before sending more.',
        )
      }

      // Loop protection: past the hop limit, or in a conversation already halted, nothing is
      // delivered. It is kept, so a person can see it and decide.
      const depth = hop - conversation.hopBase
      let state: MessageState = recipient === HUMAN ? 'delivered' : 'queued'
      let heldReason: string | null = null
      if (conversation.status === 'halted') {
        state = 'held'
        heldReason = 'this conversation is halted'
      } else if (depth > MAX_HOPS) {
        state = 'held'
        heldReason = `the chain of replies passed ${MAX_HOPS} hops`
        this.setConversationStatus(out, conversation, 'halted', `possible loop: ${heldReason}`, {
          source: 'system',
        })
      }

      const message = this.insertMessage(out, {
        conversationId: conversation.id,
        parentId,
        hop,
        fromId,
        toId: recipient,
        kind: args.kind,
        subject: args.subject,
        body: args.body,
        taskId: args.taskId ?? null,
        state,
        heldReason,
        actor,
      })
      return message
    })
  }

  /** A message from the person, to one employee. It starts a fresh chain, so it resets loop counting. */
  sendFromHuman(raw: HumanMessageInput): Message {
    const parsed = HumanMessageInputSchema.safeParse(raw)
    if (!parsed.success) throw new MessageError('invalid', firstIssue(parsed.error))
    const input = parsed.data
    const known = this.deps.directory.list().some((employee) => employee.id === input.toId)
    if (!known) throw new MessageError('unknown-recipient', 'That employee does not exist')
    if (this.queuedCount(input.toId) >= MAX_QUEUED_PER_RECIPIENT) {
      throw new MessageError('full', 'That employee has too many unread messages')
    }

    return this.transact((out) => {
      let conversation: Conversation
      let hop: number
      let parentId: string | null = null
      if (input.conversationId) {
        const found = this.getConversation(input.conversationId)
        if (!found) throw new MessageError('not-found', 'There is no such conversation')
        if (found.status === 'closed') {
          throw new MessageError('closed', 'That conversation is closed. Start a new one.')
        }
        conversation = found
        // Writing into a halted conversation is a decision to let it continue.
        if (found.status === 'halted') {
          this.reopen(out, found, 'a person wrote in it')
          conversation = this.mustConversation(found.id)
        }
        const latest = this.maxHop(found.id)
        hop = latest + 1
        parentId = this.lastMessageId(found.id)
      } else {
        conversation = this.createConversation(out, input.subject, null, { source: 'user' })
        hop = 1
      }

      // A person stepping in resets the chain: replies to this message count from here.
      this.deps.db
        .prepare('UPDATE conversations SET hop_base = @hop, updated_at = @ts WHERE id = @id')
        .run({ id: conversation.id, hop, ts: this.stamp() })

      return this.insertMessage(out, {
        conversationId: conversation.id,
        parentId,
        hop,
        fromId: HUMAN,
        toId: input.toId,
        kind: input.kind,
        subject: input.subject,
        body: input.body,
        taskId: null,
        state: 'queued',
        heldReason: null,
        actor: { source: 'user' },
      })
    })
  }

  // ---------- delivery (the router) ----------

  /** Messages waiting for this agent, oldest first. */
  queuedFor(employeeId: string, limit = 5): Message[] {
    const rows = this.deps.db
      .prepare(
        "SELECT * FROM messages WHERE to_id = ? AND state = 'queued' ORDER BY created_at, rowid LIMIT ?",
      )
      .all(employeeId, limit) as MessageRow[]
    return rows.map(toMessage)
  }

  /** Employees who have something waiting. */
  recipientsWithQueued(): string[] {
    const rows = this.deps.db
      .prepare("SELECT DISTINCT to_id FROM messages WHERE state = 'queued' AND to_id != ?")
      .all(HUMAN) as Array<{ to_id: string }>
    return rows.map((row) => row.to_id)
  }

  /** These messages reached the agent. The last one becomes what it is now answering. */
  markDelivered(messages: readonly Message[], via: 'continuation' | 'paste'): void {
    if (messages.length === 0) return
    this.transact((out) => {
      for (const message of messages) {
        this.deps.db
          .prepare(
            "UPDATE messages SET state = 'delivered', delivered_at = @ts WHERE id = @id AND state = 'queued'",
          )
          .run({ id: message.id, ts: this.stamp() })
        out.push({
          type: 'message.delivered',
          source: 'system',
          actorId: message.toId,
          payload: {
            messageId: message.id,
            conversationId: message.conversationId,
            toId: message.toId,
            via,
          },
        })
      }
    })
    const last = messages[messages.length - 1]
    if (last)
      this.handling.set(last.toId, {
        messageId: last.id,
        conversationId: last.conversationId,
        hop: last.hop,
      })
  }

  /** The agent's turn ended: it is no longer answering the last message. */
  endHandling(employeeId: string): void {
    this.handling.delete(employeeId)
  }

  /** The message an agent is currently answering, if any. */
  handlingFor(employeeId: string): Handling | undefined {
    return this.handling.get(employeeId)
  }

  // ---------- the person ----------

  listConversations(limit = 50): ConversationDetail[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC LIMIT ?')
      .all(limit) as ConversationRow[]
    return rows.map((row) => ({
      conversation: toConversation(row),
      messages: this.messagesOf(row.id),
    }))
  }

  /** Resume a halted conversation: continue counting from here and release what was held. */
  resume(conversationId: string): Conversation {
    const conversation = this.mustConversation(conversationId)
    if (conversation.status !== 'halted') {
      throw new MessageError('state', 'Only a halted conversation can be resumed')
    }
    return this.transact((out) => {
      this.reopen(out, conversation, 'resumed by a person')
      return this.mustConversation(conversationId)
    })
  }

  /** End a conversation. Anything still waiting in it is held, not delivered. */
  close(conversationId: string): Conversation {
    const conversation = this.mustConversation(conversationId)
    if (conversation.status === 'closed') throw new MessageError('state', 'It is already closed')
    return this.transact((out) => {
      this.setConversationStatus(out, conversation, 'closed', 'closed by a person', {
        source: 'user',
      })
      const waiting = this.deps.db
        .prepare("SELECT * FROM messages WHERE conversation_id = ? AND state = 'queued'")
        .all(conversationId) as MessageRow[]
      for (const row of waiting) {
        this.deps.db
          .prepare(
            "UPDATE messages SET state = 'held', held_reason = 'the conversation was closed' WHERE id = ?",
          )
          .run(row.id)
        out.push(heldEvent(row.id, conversationId, 'the conversation was closed'))
      }
      return this.mustConversation(conversationId)
    })
  }

  /** The person opened a conversation: everything sent to them in it is now read. */
  markRead(conversationId: string): void {
    this.mustConversation(conversationId)
    const unread = this.deps.db
      .prepare(
        'SELECT id FROM messages WHERE conversation_id = ? AND to_id = ? AND read_at IS NULL',
      )
      .all(conversationId, HUMAN) as Array<{ id: string }>
    if (unread.length === 0) return
    this.transact((out) => {
      for (const { id } of unread) {
        this.deps.db
          .prepare('UPDATE messages SET read_at = @ts WHERE id = @id')
          .run({ id, ts: this.stamp() })
        out.push({
          type: 'message.read',
          source: 'user',
          payload: { messageId: id, conversationId },
        })
      }
    })
  }

  /** The employees (not the person) who have sent or received something in a conversation. */
  participantsOf(conversationId: string): string[] {
    const rows = this.deps.db
      .prepare('SELECT from_id AS a, to_id AS b FROM messages WHERE conversation_id = ?')
      .all(conversationId) as Array<{ a: string; b: string }>
    const ids = new Set<string>()
    for (const { a, b } of rows) {
      if (a !== HUMAN) ids.add(a)
      if (b !== HUMAN) ids.add(b)
    }
    return [...ids]
  }

  // ---------- reading ----------

  getMessage(id: string): Message | undefined {
    const row = this.deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      MessageRow | undefined
    return row && toMessage(row)
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.deps.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      ConversationRow | undefined
    return row && toConversation(row)
  }

  // ---------- internals ----------

  /**
   * An employee who reports to a manager does not message the person directly: the manager is
   * the one who talks to them. Enforced here rather than trusted to the agent's instructions.
   * Someone with no manager (or a manager themselves) may still reach the person.
   */
  private requireToGoThroughManager(fromId: string): void {
    const employees = this.deps.directory.list()
    const me = employees.find((employee) => employee.id === fromId)
    const manager = me?.reportsTo ? employees.find((e) => e.id === me.reportsTo) : undefined
    if (!manager) return
    throw new MessageError(
      'via-manager',
      `You report to ${manager.name}, so you do not message the person directly. ` +
        `If you need something from them, send it to ${manager.name} (send_message with to: "${manager.name}") ` +
        'and they will take it to the person if it needs to go further.',
    )
  }

  /** An id, a unique name, or "human" -> who the message is for. Never the sender. */
  private resolveRecipient(to: string, fromId: string): string {
    const wanted = to.trim()
    if (wanted.toLowerCase() === HUMAN) return HUMAN
    const employees = this.deps.directory.list()
    const byId = employees.find((employee) => employee.id === wanted)
    const matches = byId
      ? [byId]
      : employees.filter((employee) => employee.name.toLowerCase() === wanted.toLowerCase())
    if (matches.length === 0) {
      throw new MessageError(
        'unknown-recipient',
        `There is no teammate "${wanted}". Use list_teammates to see who is here.`,
      )
    }
    if (matches.length > 1) {
      throw new MessageError(
        'ambiguous',
        `More than one teammate is called "${wanted}". Use their id from list_teammates.`,
      )
    }
    const match = matches[0]
    if (!match) throw new MessageError('unknown-recipient', 'No such teammate')
    if (match.id === fromId) throw new MessageError('self', 'You cannot message yourself.')
    return match.id
  }

  private createConversation(
    out: EventInput[],
    subject: string,
    missionId: string | null,
    actor: Actor,
  ): Conversation {
    const id = this.newId()
    const ts = this.stamp()
    this.deps.db
      .prepare(
        `INSERT INTO conversations (id, subject, status, mission_id, hop_base, created_at, updated_at)
         VALUES (@id, @subject, 'open', @missionId, 0, @ts, @ts)`,
      )
      .run({ id, subject: redactString(subject), missionId, ts })
    out.push({
      type: 'conversation.created',
      source: actor.source,
      payload: { conversationId: id, subject: redactString(subject) },
    })
    return this.mustConversation(id)
  }

  private insertMessage(
    out: EventInput[],
    input: {
      conversationId: string
      parentId: string | null
      hop: number
      fromId: string
      toId: string
      kind: MessageKind
      subject: string
      body: string
      taskId: string | null
      state: MessageState
      heldReason: string | null
      actor: Actor
    },
  ): Message {
    const id = this.newId()
    const ts = this.stamp()
    this.deps.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, parent_id, hop, from_id, to_id, kind, subject, body, task_id,
                               state, held_reason, created_at, delivered_at)
         VALUES (@id, @conversationId, @parentId, @hop, @fromId, @toId, @kind, @subject, @body, @taskId,
                 @state, @heldReason, @ts, @deliveredAt)`,
      )
      .run({
        id,
        conversationId: input.conversationId,
        parentId: input.parentId,
        hop: input.hop,
        fromId: input.fromId,
        toId: input.toId,
        kind: input.kind,
        subject: redactString(input.subject),
        body: redactString(input.body),
        taskId: input.taskId,
        state: input.state,
        heldReason: input.heldReason,
        ts,
        deliveredAt: input.state === 'delivered' ? ts : null,
      })
    this.deps.db
      .prepare('UPDATE conversations SET updated_at = @ts WHERE id = @id')
      .run({ id: input.conversationId, ts })

    out.push({
      type: 'message.sent',
      source: input.actor.source,
      ...(input.actor.employeeId && { actorId: input.actor.employeeId }),
      ...(input.taskId && { taskId: input.taskId }),
      payload: {
        messageId: id,
        conversationId: input.conversationId,
        fromId: input.fromId,
        toId: input.toId,
        kind: input.kind,
        hop: input.hop,
      },
    })
    if (input.state === 'held')
      out.push(heldEvent(id, input.conversationId, input.heldReason ?? 'held'))
    return this.mustMessage(id)
  }

  private setConversationStatus(
    out: EventInput[],
    conversation: Conversation,
    to: ConversationStatus,
    reason: string,
    actor: Actor,
  ): void {
    this.deps.db
      .prepare(
        'UPDATE conversations SET status = @to, halted_reason = @reason, updated_at = @ts WHERE id = @id',
      )
      .run({ id: conversation.id, to, reason: to === 'halted' ? reason : null, ts: this.stamp() })
    out.push({
      type: 'conversation.status.changed',
      source: actor.source,
      payload: { conversationId: conversation.id, from: conversation.status, to, reason },
    })
  }

  /** Open a halted conversation again: count hops from here, and release what was held. */
  private reopen(out: EventInput[], conversation: Conversation, reason: string): void {
    const base = this.maxHop(conversation.id)
    this.setConversationStatus(out, conversation, 'open', reason, { source: 'user' })
    this.deps.db
      .prepare('UPDATE conversations SET hop_base = @base WHERE id = @id')
      .run({ id: conversation.id, base })
    // What was held for the person is now simply delivered; for an agent, it goes back in the queue.
    this.deps.db
      .prepare(
        "UPDATE messages SET state = 'delivered', delivered_at = @ts, held_reason = NULL WHERE conversation_id = @id AND state = 'held' AND to_id = @human",
      )
      .run({ id: conversation.id, ts: this.stamp(), human: HUMAN })
    this.deps.db
      .prepare(
        "UPDATE messages SET state = 'queued', held_reason = NULL WHERE conversation_id = @id AND state = 'held' AND to_id != @human",
      )
      .run({ id: conversation.id, human: HUMAN })
  }

  private queuedCount(recipientId: string): number {
    return (
      this.deps.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND state = 'queued'")
        .get(recipientId) as { n: number }
    ).n
  }

  private maxHop(conversationId: string): number {
    return (
      this.deps.db
        .prepare('SELECT COALESCE(MAX(hop), 0) AS n FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { n: number }
    ).n
  }

  private lastMessageId(conversationId: string): string | null {
    const row = this.deps.db
      .prepare(
        'SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(conversationId) as { id: string } | undefined
    return row?.id ?? null
  }

  private messagesOf(conversationId: string): Message[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid')
      .all(conversationId) as MessageRow[]
    return rows.map(toMessage)
  }

  private mustConversation(id: string): Conversation {
    const found = this.getConversation(id)
    if (!found) throw new MessageError('not-found', 'There is no such conversation')
    return found
  }

  private mustMessage(id: string): Message {
    const found = this.getMessage(id)
    if (!found) throw new MessageError('not-found', 'There is no such message')
    return found
  }

  private stamp(): string {
    return this.now().toISOString()
  }

  /** One transaction; events are published only after it commits. */
  private transact<T>(work: (out: EventInput[]) => T): T {
    const out: EventInput[] = []
    const result = this.deps.db.transaction(() => work(out))()
    for (const event of out) this.deps.events.publish(event)
    return result
  }
}

function heldEvent(messageId: string, conversationId: string, reason: string): EventInput {
  return { type: 'message.held', source: 'system', payload: { messageId, conversationId, reason } }
}

function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid message'
  const field = issue.path.map(String).join('.')
  return field ? `${field}: ${issue.message}` : issue.message
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status as ConversationStatus,
    haltedReason: row.halted_reason,
    missionId: row.mission_id,
    hopBase: row.hop_base,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    hop: row.hop,
    fromId: row.from_id,
    toId: row.to_id,
    kind: row.kind as MessageKind,
    subject: row.subject,
    body: row.body,
    taskId: row.task_id,
    state: row.state as MessageState,
    heldReason: row.held_reason,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
  }
}
