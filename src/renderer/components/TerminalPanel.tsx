import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalChunk } from '@shared/ipc/api'

interface Props {
  employeeId: string
  /** Changes for every new run of the agent, so each run gets a fresh terminal. */
  runKey: string
  running: boolean
}

const THEME = {
  background: '#0f0d0b',
  foreground: '#f3ead8',
  cursor: '#e8893a',
  selectionBackground: '#e8893a55',
  black: '#1e1a17',
  brightBlack: '#6f675e',
}

/**
 * A real terminal for one employee. It shows what the agent's PTY prints and sends your
 * keystrokes back — it is the human's view, and is independent of the office. Reopening it
 * replays recent output, so switching between employees loses nothing.
 */
export function TerminalPanel({ employeeId, runKey, running }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term

    // Join the replay (what was printed before we attached) to the live stream without gaps
    // or repeats: every chunk says where it ends, and the replay says where it ended.
    let replayEnd = 0
    let attached = false
    const waiting: TerminalChunk[] = []
    const write = (chunk: TerminalChunk): void => {
      if (chunk.offset <= replayEnd) return
      const start = chunk.offset - chunk.data.length
      term.write(start < replayEnd ? chunk.data.slice(replayEnd - start) : chunk.data)
    }

    const unsubscribe = window.shokuba.terminal.subscribe((chunk) => {
      if (chunk.employeeId !== employeeId) return
      if (attached) write(chunk)
      else waiting.push(chunk)
    })

    let cancelled = false
    void window.shokuba.terminal
      .replay(employeeId)
      .then(({ data, offset }) => {
        if (cancelled) return
        replayEnd = offset
        if (data) term.write(data)
        attached = true
        for (const chunk of waiting.splice(0)) write(chunk)
      })
      .catch(() => {
        attached = true
      })

    const input = term.onData((data) => {
      void window.shokuba.terminal.write(employeeId, data).catch(() => undefined)
    })

    const sendSize = (): void => {
      try {
        fit.fit()
      } catch {
        return // the panel is hidden or has no size yet
      }
      void window.shokuba.terminal.resize(employeeId, term.cols, term.rows).catch(() => undefined)
    }
    const observer = new ResizeObserver(() => requestAnimationFrame(sendSize))
    observer.observe(host)
    requestAnimationFrame(sendSize)

    return () => {
      cancelled = true
      observer.disconnect()
      input.dispose()
      unsubscribe()
      term.dispose()
      termRef.current = null
    }
  }, [employeeId, runKey])

  useEffect(() => {
    if (termRef.current) termRef.current.options.disableStdin = !running
  }, [running, employeeId, runKey])

  return <div ref={hostRef} className="terminal-host" data-testid="terminal" />
}
