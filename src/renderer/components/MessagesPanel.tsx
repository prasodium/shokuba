import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  HUMAN,
  MAX_HOPS,
  MESSAGE_KINDS,
  type ConversationDetail,
  type MessageKind,
} from '@shared/messages'
import { defaultRecipient, hasUnread, nameOf, stateLabel } from '../messages/helpers'
import { useMessages } from '../store/messages'
import { useOffice } from '../store/office'

const KIND_LABELS: Record<MessageKind, string> = {
  request: 'Request',
  inform: 'Info',
  question: 'Question',
  handoff: 'Handoff',
  review: 'Review',
  approval: 'Approval',
  warning: 'Warning',
  completion: 'Completion',
}

/** Make sure a reason ends as a sentence, without doubling the full stop. */
function sentence(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/, '')
  return trimmed.length > 0 ? `${trimmed[0]?.toUpperCase()}${trimmed.slice(1)}.` : ''
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Conversations between employees, and with you. */
export function MessagesPanel() {
  const conversations = useMessages((s) => s.conversations)
  const selectedId = useMessages((s) => s.selectedId)
  const select = useMessages((s) => s.select)
  const markRead = useMessages((s) => s.markRead)
  const action = useMessages((s) => s.action)
  const send = useMessages((s) => s.send)
  const employees = useOffice((s) => s.employees)

  const [composing, setComposing] = useState(false)
  const [toId, setToId] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<MessageKind>('inform')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const names = useMemo(() => Object.fromEntries(employees.map((e) => [e.id, e.name])), [employees])
  const current: ConversationDetail | undefined = composing
    ? undefined
    : conversations.find((c) => c.conversation.id === selectedId)

  // Opening a conversation reads it.
  useEffect(() => {
    if (current && hasUnread(current)) void markRead(current.conversation.id)
  }, [current, markRead])

  // Reply to whoever wrote last; a new message starts with the first employee.
  useEffect(() => {
    const preferred = current
      ? defaultRecipient(
          current,
          employees.map((e) => e.id),
        )
      : null
    setToId((existing) =>
      existing && employees.some((e) => e.id === existing) && !current
        ? existing
        : (preferred ?? employees[0]?.id ?? ''),
    )
  }, [current, employees])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const outcome = await send({
      toId,
      subject: current ? `Re: ${current.conversation.subject}`.slice(0, 120) : subject,
      body,
      kind,
      conversationId: current?.conversation.id ?? null,
    })
    setBusy(false)
    if (outcome.ok) {
      setBody('')
      setSubject('')
      setComposing(false)
    } else {
      setError(outcome.error)
    }
  }

  async function decide(kindOfAction: 'resume' | 'close'): Promise<void> {
    if (!current) return
    setError(null)
    const outcome = await action(current.conversation.id, kindOfAction)
    if (!outcome.ok) setError(outcome.error)
  }

  const closed = current?.conversation.status === 'closed'

  return (
    <section className="panel messages" aria-label="Messages">
      <div className="panel-head">
        <h2>Messages</h2>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setComposing(true)
            setError(null)
          }}
          disabled={employees.length === 0}
        >
          + New message
        </button>
      </div>

      {conversations.length === 0 && !composing ? (
        <div className="empty">
          <p>
            <strong>No conversations yet.</strong>
          </p>
          <p className="muted">
            Employees can message each other, and you. Every message is kept here. If two agents
            keep answering each other, Shokuba stops the chain after {MAX_HOPS} replies and asks you
            what to do.
          </p>
        </div>
      ) : (
        <ul className="convs" aria-label="Conversations">
          {conversations.map((detail) => {
            const { conversation } = detail
            const last = detail.messages.at(-1)
            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  className={`conv ${!composing && conversation.id === selectedId ? 'is-selected' : ''}`}
                  data-status={conversation.status}
                  onClick={() => {
                    setComposing(false)
                    select(conversation.id)
                  }}
                >
                  <span className="conv-main">
                    <span className="conv-subject">
                      {hasUnread(detail) && <span className="unread-dot" aria-label="Unread" />}
                      {conversation.subject}
                    </span>
                    <span className="conv-sub">
                      {last ? `${nameOf(last.fromId, names)} → ${nameOf(last.toId, names)}` : ''} ·{' '}
                      {detail.messages.length}{' '}
                      {detail.messages.length === 1 ? 'message' : 'messages'}
                    </span>
                  </span>
                  {conversation.status !== 'open' && (
                    <span className="conv-pill" data-status={conversation.status}>
                      {conversation.status === 'halted' ? 'Halted' : 'Closed'}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {current && (
        <div className="thread">
          {current.conversation.status === 'halted' && (
            <div className="banner banner-halted" role="alert">
              <div>
                <strong>Stopped: this may be a loop.</strong>
                <p>
                  {sentence(
                    current.conversation.haltedReason ?? 'The chain of replies got too long',
                  )}{' '}
                  The last message was held and nothing more will be delivered until you decide.
                </p>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void decide('resume')}
                >
                  Let it continue
                </button>
                <button type="button" className="btn" onClick={() => void decide('close')}>
                  Close it
                </button>
              </div>
            </div>
          )}
          {closed && (
            <p className="hint">You closed this conversation. Nothing more is delivered.</p>
          )}

          <ol className="bubbles">
            {current.messages.map((message) => (
              <li
                key={message.id}
                className={`msg ${message.fromId === HUMAN ? 'from-you' : ''}`}
                data-state={message.state}
              >
                <div className="msg-head">
                  <strong>{nameOf(message.fromId, names)}</strong>
                  <span className="muted">→ {nameOf(message.toId, names)}</span>
                  <span className="kind-chip">{KIND_LABELS[message.kind]}</span>
                  <span className="muted msg-time">{time(message.createdAt)}</span>
                </div>
                <p className="msg-body">{message.body}</p>
                <div className="msg-foot muted">
                  <span>{stateLabel(message)}</span>
                  <span title="Where this message sits in the chain of replies">
                    hop {message.hop}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(composing || (current && !closed)) && (
        <form className="composer" onSubmit={(event) => void submit(event)}>
          <div className="grid-2">
            <label className="field">
              <span>To</span>
              <select value={toId} onChange={(e) => setToId(e.target.value)} required>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name} · {employee.role}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Kind</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as MessageKind)}>
                {MESSAGE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!current && (
            <label className="field">
              <span>Subject</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={120}
                required
              />
            </label>
          )}
          <label className="field">
            <span>{current ? 'Reply' : 'Message'}</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              maxLength={4000}
              required
            />
          </label>
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !toId}>
              Send
            </button>
            {composing && (
              <button type="button" className="btn" onClick={() => setComposing(false)}>
                Cancel
              </button>
            )}
            <span className="muted">
              Your message reaches them when they finish their current turn, and starts the count of
              replies afresh.
            </span>
          </div>
        </form>
      )}
    </section>
  )
}
