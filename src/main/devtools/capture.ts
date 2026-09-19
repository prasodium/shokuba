import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  /**
   * Take a run of screenshots at a steady pace into a folder (`frame-0001.png`, …), to make an
   * animation from. `crop` is a region of the page in CSS pixels.
   */
  z.strictObject({
    frames: z.strictObject({
      dir: z.string().min(1),
      count: z.number().int().min(1).max(600),
      everyMs: z.number().int().min(30).max(5_000),
      crop: z
        .strictObject({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          width: z.number().int().min(1),
          height: z.number().int().min(1),
        })
        .optional(),
    }),
  }),
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
    } else if ('frames' in step) {
      const { dir, count, everyMs, crop } = step.frames
      mkdirSync(dir, { recursive: true })
      const started = Date.now()
      for (let i = 0; i < count; i += 1) {
        // Keep to the schedule, so a slow frame does not push every later one back.
        const wait = started + i * everyMs - Date.now()
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        const image = await window.webContents.capturePage(crop)
        writeFileSync(join(dir, `frame-${String(i + 1).padStart(4, '0')}.png`), image.toPNG())
      }
      // The real time taken is reported, so the animation can be played at the pace it happened.
      report(`frames ${count} in ${Date.now() - started}ms`)
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
