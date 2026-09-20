import { z } from 'zod'
import { shortText } from './employees'

/**
 * A department: a named group of people with a colour. In the office a department's people sit
 * together as a block with a name plate on the floor in its colour, and the roster groups them.
 * It is separate from a team (a manager and the people who report to them): a team decides who
 * talks to whom, a department only decides where people sit and how they are listed.
 */
export interface Department {
  id: string
  name: string
  /** The plate's colour, #rrggbb. */
  color: string
  createdAt: string
  updatedAt: string
}

/** The colours offered for a plate. Any `#rrggbb` is accepted, but these are what the editor shows. */
export const DEPARTMENT_COLORS = [
  '#5b8fc7',
  '#6f9a5b',
  '#e8893a',
  '#c76b8f',
  '#8f7bd1',
  '#d1b34a',
  '#4fb3a5',
  '#c96a6a',
] as const

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export const DepartmentInputSchema = z.strictObject({
  name: shortText,
  color: hexColor.default(DEPARTMENT_COLORS[0]),
})
export type DepartmentInput = z.input<typeof DepartmentInputSchema>

export const DepartmentUpdateSchema = z.strictObject({
  name: shortText.optional(),
  color: hexColor.optional(),
})
export type DepartmentUpdate = z.infer<typeof DepartmentUpdateSchema>
