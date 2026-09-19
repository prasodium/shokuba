import * as nodePty from 'node-pty'

/** The slice of a pseudo-terminal the runtime needs, so tests can substitute a fake. */
export interface PtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): void
  onExit(listener: (exit: { exitCode: number; signal: number | null }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
}

export interface PtySpawnOptions {
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess

/** The real thing: node-pty (ConPTY on Windows, forkpty elsewhere). */
export const spawnNodePty: PtySpawn = (file, args, options) => {
  const child = nodePty.spawn(file, args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  })
  return {
    pid: child.pid,
    onData: (listener) => void child.onData(listener),
    onExit: (listener) =>
      void child.onExit(({ exitCode, signal }) =>
        listener({ exitCode, signal: signal === undefined || signal === 0 ? null : signal }),
      ),
    write: (data) => child.write(data),
    resize: (cols, rows) => child.resize(cols, rows),
  }
}
