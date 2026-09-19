import { HUMAN, type ConversationDetail, type Message } from '@shared/messages'

/** What to call an id in the thread: the person is "You". */
export function nameOf(id: string, names: Readonly<Record<string, string>>): string {
  if (id === HUMAN) return 'You'
  return names[id] ?? 'Removed employee'
}

/** Messages sent to the person that they have not opened yet. */
export function unreadCount(conversations: readonly ConversationDetail[]): number {
  let count = 0
  for (const { messages } of conversations) {
    for (const message of messages)
      if (message.toId === HUMAN && message.readAt === null) count += 1
  }
  return count
}

/** Conversations stopped as possible loops, waiting for a person to decide. */
export function haltedCount(conversations: readonly ConversationDetail[]): number {
  return conversations.filter((c) => c.conversation.status === 'halted').length
}

/** What deserves a person's attention: unread messages, and conversations that were stopped. */
export function attentionCount(conversations: readonly ConversationDetail[]): number {
  return unreadCount(conversations) + haltedCount(conversations)
}

/** Whether a conversation has something new for the person. */
export function hasUnread(detail: ConversationDetail): boolean {
  return detail.messages.some((m) => m.toId === HUMAN && m.readAt === null)
}

/**
 * Who a reply from the person should go to by default: whoever wrote the last message that
 * was not from the person, else whoever the person last wrote to.
 */
export function defaultRecipient(
  detail: ConversationDetail,
  employeeIds: readonly string[],
): string | null {
  const known = new Set(employeeIds)
  for (const message of [...detail.messages].reverse()) {
    const other = message.fromId === HUMAN ? message.toId : message.fromId
    if (other !== HUMAN && known.has(other)) return other
  }
  return null
}

/** How a message is doing, in words. */
export function stateLabel(message: Pick<Message, 'state' | 'heldReason' | 'toId'>): string {
  if (message.state === 'held') return `Held: ${message.heldReason ?? 'not delivered'}`
  if (message.state === 'queued') return 'Waiting to be delivered'
  return message.toId === HUMAN ? 'In your inbox' : 'Delivered'
}
