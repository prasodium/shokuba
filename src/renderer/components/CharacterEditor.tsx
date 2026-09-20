import { useEffect, useRef } from 'react'
import {
  ACCESSORIES,
  HAIR_COLORS,
  HAIR_STYLES,
  SKIN_TONES,
  type Appearance,
} from '@shared/appearance'
import { hexToNumber } from '../office/iso'
import { fitPreview, previewOf } from '../office/preview'

const WIDTH = 170
const HEIGHT = 190

const css = (color: number): string => `#${color.toString(16).padStart(6, '0')}`

/** The person drawn as the office draws them, so the form shows what the office will. */
function CharacterPreview({ look, shirt }: { look: Appearance; shirt: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = canvas.current
    const ctx = element?.getContext('2d')
    if (!element || !ctx) return
    const ratio = window.devicePixelRatio || 1
    element.width = WIDTH * ratio
    element.height = HEIGHT * ratio
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, element.width, element.height)

    const preview = previewOf(look, hexToNumber(shirt))
    const fit = fitPreview(preview.bounds, element.width, element.height, 10 * ratio)
    ctx.setTransform(fit.scale, 0, 0, fit.scale, fit.x, fit.y)
    for (const polygon of preview.polygons) {
      ctx.globalAlpha = polygon.alpha
      ctx.fillStyle = css(polygon.color)
      ctx.beginPath()
      for (let i = 0; i < polygon.points.length; i += 2) {
        const x = polygon.points[i] as number
        const y = polygon.points[i + 1] as number
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }, [look, shirt])

  return (
    <canvas
      ref={canvas}
      className="character-preview"
      style={{ width: WIDTH, height: HEIGHT }}
      role="img"
      aria-label="How this employee will look in the office"
    />
  )
}

interface Choice<T extends string> {
  id: T
  label: string
  /** A colour to show, for the choices that are colours. */
  hex?: string
}

/** One row of choices: swatches for colours, words for the rest. Exactly one is chosen. */
function Choices<T extends string>({
  name,
  legend,
  choices,
  value,
  onChange,
}: {
  name: string
  legend: string
  choices: readonly Choice<T>[]
  value: T
  onChange(id: T): void
}) {
  return (
    <fieldset className="field">
      <legend>{legend}</legend>
      <div className={choices[0]?.hex ? 'swatches' : 'chips'}>
        {choices.map((choice) => (
          <label
            key={choice.id}
            className={choice.hex ? 'swatch-choice' : 'chip-choice'}
            title={choice.label}
          >
            <input
              type="radio"
              name={name}
              value={choice.id}
              checked={value === choice.id}
              onChange={() => onChange(choice.id)}
              aria-label={choice.label}
            />
            {choice.hex ? <span style={{ background: choice.hex }} /> : <span>{choice.label}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** Change how an employee looks: skin, hair colour, hair style and what they wear, with a preview. */
export function CharacterEditor({
  value,
  shirt,
  onChange,
}: {
  value: Appearance
  shirt: string
  onChange(next: Appearance): void
}) {
  return (
    <fieldset className="field character">
      <legend>Character</legend>
      <div className="character-row">
        <CharacterPreview look={value} shirt={shirt} />
        <div className="character-choices">
          <Choices
            name="skin"
            legend="Skin"
            choices={SKIN_TONES}
            value={value.skin}
            onChange={(skin) => onChange({ ...value, skin })}
          />
          <Choices
            name="hair"
            legend="Hair colour"
            choices={HAIR_COLORS}
            value={value.hair}
            onChange={(hair) => onChange({ ...value, hair })}
          />
          <Choices
            name="style"
            legend="Hair style"
            choices={HAIR_STYLES}
            value={value.style}
            onChange={(style) => onChange({ ...value, style })}
          />
          <Choices
            name="accessory"
            legend="Wears"
            choices={ACCESSORIES}
            value={value.accessory}
            onChange={(accessory) => onChange({ ...value, accessory })}
          />
        </div>
      </div>
    </fieldset>
  )
}
