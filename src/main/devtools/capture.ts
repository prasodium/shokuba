import { readFileSync, writeFileSync } from 'node:fs'
import type { BrowserWindow } from 'electron'
import { z } from 'zod'

/**
 * A scripted timeline for the running app, used to verify the UI and to take repeatable
 * screenshots without needing OS screen-recording permission. Development only: it is
 * never honoured by a packaged build (see main/index.ts).
 *
 *   [{ "wait": 1500 }, { "eval": "window.shokuba.app.info()" }, { "shot": "/tmp/a.png" }]
 */
const StepSchema = z.union([
  z.strictObject({ wait: z.number().int().min(0).max(120_000) }),
  z.strictObject({ eval: z.string().min(1) }),
  z.strictObject({ shot: z.string().min(1) }),
  /** Type text into the focused element, as the keyboard would. */
  z.strictObject({ type: z.string().min(1).max(500) }),
  /** Press a key (e.g. "Enter") or chord (e.g. "Ctrl+C"). */
  z.strictObject({ press: z.string().min(1).max(40) }),
])
export const CapturePlanSchema = z.array(StepSchema).max(200)
export type CapturePlan = z.infer<typeof CapturePlanSchema>

export function readCapturePlan(file: string): CapturePlan {
  return CapturePlanSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

export async function runCapturePlan(
  window: BrowserWindow,
  plan: CapturePlan,
  report: (line: string) => void,
): Promise<void> {
  for (const step of plan) {
    if ('wait' in step) {
      await new Promise((resolve) => setTimeout(resolve, step.wait))
    } else if ('type' in step) {
      await window.webContents.insertText(step.type)
      report(`typed ${step.type.length} characters`)
    } else if ('press' in step) {
      pressKey(window, step.press)
      report(`pressed ${step.press}`)
    } else if ('eval' in step) {
      try {
        const result: unknown = await window.webContents.executeJavaScript(step.eval)
        report(`eval ok: ${JSON.stringify(result) ?? 'undefined'}`)
      } catch (error) {
        report(`eval FAILED: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      const image = await window.webContents.capturePage()
      writeFileSync(step.shot, image.toPNG())
      report(`shot ${step.shot} (${image.getSize().width}x${image.getSize().height})`)
    }
  }
}

/** Send a real key event to the page. Enough keys for driving a terminal. */
function pressKey(window: BrowserWindow, chord: string): void {
  const parts = chord.split('+')
  const key = parts.pop() ?? ''
  const modifiers = parts.map((m) => m.toLowerCase()) as Array<'control' | 'shift' | 'alt'>
  const normalised = modifiers.map((m) => (m === ('ctrl' as string) ? 'control' : m))
  const keyCode = key === 'Enter' ? 'Return' : key
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: normalised })
  // Printable keys also need a `char` event for the page to receive text.
  if (key === 'Enter')
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: normalised })
  else if (key.length === 1 && normalised.length === 0) {
    window.webContents.sendInputEvent({ type: 'char', keyCode: key })
  }
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: normalised })
}
