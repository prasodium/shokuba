import { z } from 'zod'
import type { AgentView } from '../agents/view'
import type { BreakerAction } from '../breaker'
import {
  EmployeeInputSchema,
  EmployeeUpdateSchema,
  type Employee,
  type EmployeeInput,
  type EmployeeUpdate,
  type PermissionMode,
} from '../employees'
import type { ShokubaEvent } from '../events/schema'
import type { MissionBranchInfo, TaskChanges } from '../git'
import type { EvidenceExportResult } from '../evidence'
import type { ReviewSettings, ReviewSettingsSave, TaskReview } from '../reviews'
import type {
  CheckSettings,
  CheckSettingsSave,
  CheckStepInput,
  TaskVerification,
} from '../verification'
import {
  CONVERSATION_ACTIONS,
  HumanMessageInputSchema,
  type Conversation,
  type ConversationAction,
  type ConversationDetail,
  type HumanMessageInput,
  type Message,
} from '../messages'
import {
  MISSION_ACTIONS,
  MissionInputSchema,
  MissionUpdateSchema,
  TaskActionSchema,
  TaskInputSchema,
  TaskUpdateSchema,
  type Mission,
  type MissionAction,
  type MissionDetail,
  type MissionInput,
  type MissionUpdate,
  type Task,
  type TaskAction,
  type TaskInput,
  type TaskUpdate,
} from '../missions'

export const EventsListRequestSchema = z.strictObject({
  afterSeq: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
})
export type EventsListRequest = z.input<typeof EventsListRequestSchema>

const employeeId = z.string().min(1).max(200)

export const EmployeeIdRequestSchema = z.strictObject({ employeeId })
export const EmployeeCreateRequestSchema = EmployeeInputSchema
export const EmployeeUpdateRequestSchema = z.strictObject({
  employeeId,
  patch: EmployeeUpdateSchema,
})
export const TerminalWriteRequestSchema = z.strictObject({
  employeeId,
  // Keystrokes and pastes; a paste larger than this is chunked by the caller.
  data: z.string().max(64 * 1024),
})
export const TerminalResizeRequestSchema = z.strictObject({
  employeeId,
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500),
})

export const MissionCreateRequestSchema = MissionInputSchema
export const MissionUpdateRequestSchema = z.strictObject({
  missionId: employeeId,
  patch: MissionUpdateSchema,
})
export const MissionActionRequestSchema = z.strictObject({
  missionId: employeeId,
  action: z.enum(MISSION_ACTIONS),
})
export const MissionIdRequestSchema = z.strictObject({ missionId: employeeId })
export const TaskCreateRequestSchema = TaskInputSchema
export const TaskUpdateRequestSchema = z.strictObject({
  taskId: employeeId,
  patch: TaskUpdateSchema,
})
export const TaskActionRequestSchema = z.strictObject({
  taskId: employeeId,
  action: TaskActionSchema,
})
export const TaskIdRequestSchema = z.strictObject({ taskId: employeeId })
export const RepoRootRequestSchema = z.strictObject({ repoRoot: z.string().min(1).max(1_024) })
/** Ask for a review of a task; no reviewer means the project's own. */
export const ReviewRequestSchema = z.strictObject({
  taskId: employeeId,
  reviewerId: employeeId.nullable(),
})

export const MessageSendRequestSchema = HumanMessageInputSchema
export const ConversationIdRequestSchema = z.strictObject({ conversationId: employeeId })
export const ConversationActionRequestSchema = z.strictObject({
  conversationId: employeeId,
  action: z.enum(CONVERSATION_ACTIONS),
})

export interface AppInfo {
  name: string
  version: string
  platform: 'darwin' | 'win32' | 'linux'
  electronVersion: string
  nodeVersion: string
  schemaVersion: number
  eventCount: number
  /** The user's home folder, offered as a starting point when choosing where an employee works. */
  homeDirectory: string
}

/** What Shokuba found out about a provider's CLI on this machine. */
export interface ProviderInfo {
  id: string
  displayName: string
  /** Everything this provider tells us is demo data, not a real agent. */
  simulated: boolean
  supportsModelSelection: boolean
  permissionModes: PermissionMode[]
  installation: {
    found: boolean
    path: string | null
    version: string | null
    /** Why the provider cannot be launched, when `found` is false or launch is unsupported. */
    problem: string | null
  }
}

export interface AgentSnapshot {
  views: AgentView[]
  /** Events with a higher seq than this are newer than the snapshot. */
  lastSeq: number
}

export interface TerminalChunk {
  employeeId: string
  data: string
  /** Stream position after `data`. The chunk starts at `offset - data.length`. */
  offset: number
}

export interface TerminalReplay {
  data: string
  /** Stream position at the end of `data`; skip live chunks that end at or before it. */
  offset: number
}

/** The complete surface the preload script exposes to the renderer as `window.shokuba`. */
export interface ShokubaApi {
  app: {
    info(): Promise<AppInfo>
  }
  events: {
    list(request?: EventsListRequest): Promise<ShokubaEvent[]>
    /** Subscribe to newly published events. Returns an unsubscribe function. */
    subscribe(listener: (event: ShokubaEvent) => void): () => void
  }
  providers: {
    list(): Promise<ProviderInfo[]>
  }
  employees: {
    list(): Promise<Employee[]>
    create(input: EmployeeInput): Promise<Employee>
    update(employeeId: string, patch: EmployeeUpdate): Promise<Employee>
    archive(employeeId: string): Promise<void>
  }
  agents: {
    snapshot(): Promise<AgentSnapshot>
    start(employeeId: string): Promise<void>
    stop(employeeId: string): Promise<void>
    interrupt(employeeId: string): Promise<void>
  }
  missions: {
    list(): Promise<MissionDetail[]>
    create(input: MissionInput): Promise<Mission>
    update(missionId: string, patch: MissionUpdate): Promise<Mission>
    /** Run, pause or cancel. Running starts handing ready tasks to idle employees. */
    action(missionId: string, action: MissionAction): Promise<Mission>
    archive(missionId: string): Promise<void>
    /** Where the mission's accepted work is collecting, for you to review and merge. */
    branches(missionId: string): Promise<MissionBranchInfo[]>
  }
  tasks: {
    create(input: TaskInput): Promise<Task>
    update(taskId: string, patch: TaskUpdate): Promise<Task>
    action(taskId: string, action: TaskAction): Promise<Task>
    remove(taskId: string): Promise<void>
    /** What the task changed in its own Git branch, for review. */
    changes(taskId: string): Promise<TaskChanges>
  }
  checks: {
    /** The checks set up for a project (a repository Shokuba has worked in). */
    get(repoRoot: string): Promise<CheckSettings>
    /** Replace a project's checks. Nothing runs without the acknowledgement. */
    save(input: CheckSettingsSave): Promise<CheckSettings>
    /** Suggestions from the project's own files. Nothing is saved. */
    suggest(repoRoot: string): Promise<CheckStepInput[]>
    /** Where a task stands on verification, and its latest run. */
    forTask(taskId: string): Promise<TaskVerification>
    /** Run the checks again on a task's work. */
    run(taskId: string): Promise<void>
  }
  reviews: {
    /** Where a task stands on independent review, and the project's review settings. */
    forTask(taskId: string): Promise<TaskReview>
    /** Ask a different employee to review a task's submitted work. */
    request(taskId: string, reviewerId: string | null): Promise<void>
    /** Who reviews a project's work, and whether it is asked for on every submission. */
    saveSettings(input: ReviewSettingsSave): Promise<ReviewSettings>
  }
  evidence: {
    /**
     * Save a task's evidence pack as a new folder. The person chooses where in a dialog the app
     * shows; null if they cancel. The page never names a path.
     */
    export(taskId: string): Promise<EvidenceExportResult | null>
  }
  messages: {
    /** Recent conversations, newest first. */
    list(): Promise<ConversationDetail[]>
    /** A message from the person to one employee. */
    send(input: HumanMessageInput): Promise<Message>
    /** Mark everything sent to the person in a conversation as read. */
    markRead(conversationId: string): Promise<void>
    /** Resume a halted conversation (lets it continue and releases held messages) or close it. */
    action(conversationId: string, action: ConversationAction): Promise<Conversation>
  }
  breaker: {
    /** Reset an agent's breaker, or pause or stop it by hand. */
    action(employeeId: string, action: BreakerAction): Promise<void>
  }
  terminal: {
    write(employeeId: string, data: string): Promise<void>
    resize(employeeId: string, cols: number, rows: number): Promise<void>
    /** Everything the terminal printed so far (bounded), for re-attaching. */
    replay(employeeId: string): Promise<TerminalReplay>
    subscribe(listener: (chunk: TerminalChunk) => void): () => void
  }
  system: {
    /** Native folder picker. Resolves to null if the user cancels. */
    pickDirectory(): Promise<string | null>
  }
}
