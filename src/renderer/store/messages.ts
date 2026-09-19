import { create } from 'zustand'
import type {
  ConversationAction,
  ConversationDetail,
  HumanMessageInput,
  Message,
} from '@shared/messages'
import { errorMessage } from '../lib/errors'
import type { Outcome } from './missions'

interface MessagesState {
  conversations: ConversationDetail[]
  /** The open conversation, or null when writing a new message. */
  selectedId: string | null

  refresh(): Promise<void>
  select(id: string | null): void
  send(input: HumanMessageInput): Promise<Outcome<Message>>
  markRead(conversationId: string): Promise<void>
  action(conversationId: string, action: ConversationAction): Promise<Outcome>
}

export const useMessages = create<MessagesState>((set, get) => {
  let inFlight: Promise<void> | undefined
  let again = false

  async function attempt<T>(work: () => Promise<T>): Promise<Outcome<T>> {
    try {
      const value = await work()
      await get().refresh()
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  return {
    conversations: [],
    selectedId: null,

    async refresh() {
      if (inFlight) {
        again = true
        return inFlight
      }
      inFlight = (async () => {
        try {
          do {
            again = false
            const conversations = await window.shokuba.messages.list()
            set((state) => ({
              conversations,
              // Keep the open conversation if it still exists; otherwise show the newest.
              selectedId:
                state.selectedId &&
                conversations.some((c) => c.conversation.id === state.selectedId)
                  ? state.selectedId
                  : (conversations[0]?.conversation.id ?? null),
            }))
          } while (again)
        } catch {
          // The next event will trigger another attempt.
        } finally {
          inFlight = undefined
        }
      })()
      return inFlight
    },

    select: (id) => set({ selectedId: id }),

    async send(input) {
      const outcome = await attempt(() => window.shokuba.messages.send(input))
      if (outcome.ok) set({ selectedId: outcome.value.conversationId })
      return outcome
    },

    async markRead(conversationId) {
      try {
        await window.shokuba.messages.markRead(conversationId)
        await get().refresh()
      } catch {
        // Not worth interrupting anyone for.
      }
    },

    action: (conversationId, action) =>
      attempt(async () => void (await window.shokuba.messages.action(conversationId, action))),
  }
})
