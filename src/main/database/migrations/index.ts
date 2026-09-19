import type { Migration } from '../migrator'
import { foundation } from './0001_foundation'
import { employees } from './0002_employees'

/** Ordered list of every migration. Append new ones; never edit or reorder old ones. */
export const MIGRATIONS: readonly Migration[] = [foundation, employees]
