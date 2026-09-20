import type { Migration } from '../migrator'
import { foundation } from './0001_foundation'
import { employees } from './0002_employees'
import { missions } from './0003_missions'
import { messages } from './0004_messages'
import { teams } from './0005_teams'
import { missionAuthors } from './0006_mission_authors'
import { workspaces } from './0007_workspaces'
import { workspaceRemoval } from './0008_workspace_removal'
import { checks } from './0009_checks'
import { reviews } from './0010_reviews'
import { appearance } from './0011_appearance'

/** Ordered list of every migration. Append new ones; never edit or reorder old ones. */
export const MIGRATIONS: readonly Migration[] = [
  foundation,
  employees,
  missions,
  messages,
  teams,
  missionAuthors,
  workspaces,
  workspaceRemoval,
  checks,
  reviews,
  appearance,
]
