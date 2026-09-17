import { z } from "zod";
import { themeSchema } from "./themes";
import type { components } from "./openapi";
import { focusCommandSchema, type FocusState } from "./focus";
import {
  draftSchema,
  stickerId,
  type Attachment,
  type StagedAttachment,
  type ChatDraft,
  type TransferProgress,
  type StickerId,
} from "./chat";
export * from "./chat";

export type ApiSchemas = components["schemas"];

export const id = z.uuid();
const date = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())
  .nullable();
export const taskBodySchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    description: z.string().max(20000).default(""),
    status: z.enum(["todo", "in_progress", "done"]).default("todo"),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    start_at: date.default(null),
    due_at: date.default(null),
    reminder_at: date.default(null),
    project_id: id.nullable().default(null),
    parent_id: id.nullable().default(null),
    assignee_id: id.nullable().default(null),
    inherit_due: z.boolean().default(false),
    inherit_reminder: z.boolean().default(false),
    inherit_priority: z.boolean().default(false),
  })
  .strict();
export const projectBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(20000).default(""),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#5367df"),
    archived: z.boolean().default(false),
  })
  .strict();
export const userSchema = z.object({
  id,
  account_id: z.string().regex(/^TL-[0-9]{4}-[0-9]{4}$/),
  name: z.string(),
  email: z.string().email(),
  avatar: z
    .string()
    .max(100000)
    .regex(/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/)
    .nullable()
    .optional(),
});
export type User = z.infer<typeof userSchema>;
export type TaskBody = z.infer<typeof taskBodySchema>;
export type ProjectBody = z.infer<typeof projectBodySchema>;
export type Kind = "task" | "project";
export interface Entity<B = TaskBody | ProjectBody> {
  id: string;
  kind: Kind;
  owner_id: string;
  workspace_id: string | null;
  body: B;
  version: number;
  deleted: boolean;
  updated_at: string;
}
export type Task = Entity<TaskBody>;
export type Project = Entity<ProjectBody>;
export interface Workspace {
  id: string;
  name: string;
  owner_id: string;
  role: "owner" | "admin" | "member" | "viewer";
  version: number;
  deleted: boolean;
}
export interface Member extends User {
  role: Workspace["role"];
}
export interface Invitation {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
}
export interface Friend {
  id: string;
  user: User;
  status: "pending" | "accepted" | "rejected";
  incoming: boolean;
}
export interface Message {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  created_at: string;
  sticker_id?: StickerId | null;
  attachments?: Attachment[];
}
export interface Note {
  id: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
  local?: boolean;
}
export interface Conflict {
  operation_id: string;
  entity_id: string;
  local: Entity;
  remote: Entity | null;
  code: string;
  message: string;
}
export interface SyncStatus {
  state: "idle" | "syncing" | "offline" | "error" | "auth_required";
  pending: number;
  conflicts: number;
  lastSynced: string | null;
  error: string | null;
  nextRetry: number | null;
  paused: boolean;
}
export const preferencesSchema = z
  .object({
    theme: themeSchema,
    notifications: z.boolean(),
    closeToTray: z.boolean(),
    notificationPreview: z.boolean().default(false),
    taskLayout: z.enum(["list", "board"]).optional(),
    taskSort: z.enum(["due", "priority", "updated", "title"]).optional(),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;
// Patch fields deliberately have no defaults: an omitted setting must remain
// unchanged when another window updates only the theme or list layout.
export const preferencesPatchSchema = z
  .object({
    theme: themeSchema.optional(),
    notifications: z.boolean().optional(),
    closeToTray: z.boolean().optional(),
    notificationPreview: z.boolean().optional(),
    taskLayout: z.enum(["list", "board"]).optional(),
    taskSort: z.enum(["due", "priority", "updated", "title"]).optional(),
  })
  .strict();
export const taskStatusSchema = z
  .object({
    id,
    status: z.enum(["todo", "in_progress", "done"]),
    expectedStatus: z.enum(["todo", "in_progress", "done"]).optional(),
  })
  .strict();
export const taskBatchSchema = z
  .object({
    ids: z.array(id).min(1).max(100),
    patch: z
      .object({
        status: z.enum(["todo", "in_progress", "done"]).optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        due_at: date.optional(),
      })
      .strict()
      .refine((patch) => Object.keys(patch).length > 0),
  })
  .strict();
export interface UpdateStatus {
  version: string;
  state:
    "disabled" | "idle" | "checking" | "available" | "downloaded" | "error";
  message: string;
}
const empty = z.object({}).strict();
const key = z.object({ id }).strict();
const saveTask = z
  .object({
    id: id.optional(),
    workspace_id: id.nullable(),
    body: taskBodySchema,
  })
  .strict();
const saveProject = z
  .object({
    id: id.optional(),
    workspace_id: id.nullable(),
    body: projectBodySchema,
  })
  .strict();
const credentials = z
  .object({
    identifier: z.string().trim().min(3).max(320),
    password: z.string().min(1).max(128),
  })
  .strict();
export const commands = {
  "auth.status": empty,
  "auth.login": credentials,
  "auth.register": credentials
    .extend({
      email: z.email(),
      name: z.string().trim().min(1).max(120),
      email_verification_id: id,
      email_verification_code: z.string().regex(/^[0-9]{6}$/),
      password: z.string().min(10).max(128),
    })
    .omit({ identifier: true }),
  "auth.registrationCode": z.object({ email: z.email() }).strict(),
  "auth.passwordForgot": z.object({ email: z.email() }).strict(),
  "auth.passwordReset": z
    .object({
      request_id: id,
      code: z.string().regex(/^[0-9]{6}$/),
      password: z.string().min(10).max(128),
    })
    .strict(),
  "auth.logout": empty,
  "tasks.list": empty,
  "tasks.save": saveTask,
  "tasks.delete": key,
  "projects.list": empty,
  "projects.save": saveProject,
  "projects.delete": key,
  "sync.status": empty,
  "sync.run": empty,
  "sync.pause": z.object({ paused: z.boolean() }).strict(),
  "sync.conflicts": empty,
  "sync.resolve": z
    .object({ operation_id: id, choice: z.enum(["server", "local", "copy"]) })
    .strict(),
  "workspaces.list": empty,
  "workspaces.create": z
    .object({ name: z.string().trim().min(1).max(160) })
    .strict(),
  "workspaces.rename": z
    .object({ id, name: z.string().trim().min(1).max(160) })
    .strict(),
  "workspaces.members": key,
  "workspaces.invite": z
    .object({
      id,
      email: z.email(),
      role: z.enum(["admin", "member", "viewer"]),
    })
    .strict(),
  "workspaces.role": z
    .object({ id, user_id: id, role: z.enum(["admin", "member", "viewer"]) })
    .strict(),
  "workspaces.remove": z.object({ id, user_id: id }).strict(),
  "invitations.list": empty,
  "invitations.decide": z.object({ id, accept: z.boolean() }).strict(),
  "friends.list": empty,
  "friends.add": z.object({ email: z.email() }).strict(),
  "friends.decide": z.object({ id, accept: z.boolean() }).strict(),
  "friends.remove": key,
  "chat.open": z.object({ peer_id: id.optional() }).strict(),
  "chat.context": empty,
  "chat.close": empty,
  "chat.draft": z.object({ peer_id: id }).strict(),
  "chat.activity": z.object({ peer_id: id }).strict(),
  "chat.saveDraft": z.object({ peer_id: id, draft: draftSchema }).strict(),
  "chat.conversations": empty,
  "profile.avatar": empty,
  "profile.update": z
    .object({ name: z.string().trim().min(1).max(120) })
    .strict(),
  "attachments.pick": z
    .object({ peer_id: id, images_only: z.boolean().default(false) })
    .strict(),
  "attachments.staged": z.object({ peer_id: id }).strict(),
  "attachments.remove": key,
  "attachments.preview": key,
  "attachments.info": key,
  "attachments.save": key,
  "attachments.cancel": key,
  "messages.list": z
    .object({
      peer_id: id,
      limit: z.number().int().min(1).max(200).default(100),
      before: z
        .object({ created_at: z.string().datetime({ offset: true }), id })
        .strict()
        .optional(),
    })
    .strict(),
  "messages.send": z
    .object({
      id: id.optional(),
      recipient_id: id,
      body: z.string().trim().max(4000).default(""),
      sticker_id: stickerId.nullable().default(null),
      attachment_ids: z.array(id).max(5).default([]),
    })
    .strict()
    .refine(
      (value) =>
        !!value.body || !!value.sticker_id || value.attachment_ids.length > 0,
    ),
  "notifications.list": empty,
  "notifications.read": key,
  "settings.get": empty,
  "settings.set": preferencesSchema,
  "settings.patch": preferencesPatchSchema,
  "focus.get": empty,
  "focus.command": focusCommandSchema,
  "tasks.batch": taskBatchSchema,
  "tasks.status": taskStatusSchema,
  "tasks.undoStatus": key,
  "tasks.duplicate": key,
  "system.copyText": z.object({ text: z.string().min(1).max(4096) }).strict(),
  "data.export": empty,
  "data.import": empty,
  "data.backup": z
    .object({ passphrase: z.string().min(12).max(256).optional() })
    .strict(),
  "data.restore": z
    .object({ passphrase: z.string().min(12).max(256).optional() })
    .strict(),
  "updates.status": empty,
  "updates.check": empty,
  "updates.install": empty,
} as const;
export type Command = keyof typeof commands;
export type Inputs = { [K in Command]: z.input<(typeof commands)[K]> };
export interface Outputs {
  "auth.status": User | null;
  "auth.login": User;
  "auth.register": User;
  "auth.registrationCode": {
    request_id: string;
    expires_in: number;
    resend_after: number;
  };
  "auth.passwordForgot": {
    request_id: string;
    expires_in: number;
    resend_after: number;
  };
  "auth.passwordReset": { reset: boolean };
  "auth.logout": null;
  "tasks.list": Task[];
  "tasks.save": Task;
  "tasks.status": {
    task: Task;
    previous: TaskBody["status"];
    undoId: string | null;
    changedCount: number;
  };
  "tasks.undoStatus": Task;
  "tasks.delete": null;
  "projects.list": Project[];
  "projects.save": Project;
  "projects.delete": null;
  "sync.status": SyncStatus;
  "sync.run": SyncStatus;
  "sync.pause": SyncStatus;
  "sync.conflicts": Conflict[];
  "sync.resolve": null;
  "workspaces.list": Workspace[];
  "workspaces.create": Workspace;
  "workspaces.rename": Workspace;
  "workspaces.members": Member[];
  "workspaces.invite": { status: string };
  "workspaces.role": { status: string };
  "workspaces.remove": { status: string };
  "invitations.list": Invitation[];
  "invitations.decide": { status: string };
  "friends.list": Friend[];
  "friends.add": Friend;
  "friends.decide": Friend;
  "friends.remove": { status: string };
  "messages.list": Message[];
  "messages.send": Message;
  "chat.open": null;
  "chat.context": { peer_id: string | null };
  "chat.close": null;
  "chat.draft": ChatDraft;
  "chat.activity": { sending: boolean };
  "chat.saveDraft": null;
  "chat.conversations": { peer_id: string; last: Message }[];
  "profile.avatar": { canceled: boolean; user?: User };
  "profile.update": User;
  "attachments.pick": StagedAttachment[];
  "attachments.staged": StagedAttachment[];
  "attachments.remove": null;
  "attachments.preview": { data_url: string };
  "attachments.info": Attachment;
  "attachments.save": { canceled: boolean; name?: string };
  "attachments.cancel": null;
  "notifications.list": Note[];
  "notifications.read": Note;
  "settings.get": Preferences;
  "settings.set": Preferences;
  "settings.patch": Preferences;
  "focus.get": FocusState;
  "focus.command": FocusState;
  "tasks.batch": Task[];
  "tasks.duplicate": Task;
  "system.copyText": null;
  "data.export": { canceled: boolean };
  "data.import": { canceled: boolean; count?: number };
  "data.backup": { canceled: boolean };
  "data.restore": { canceled: boolean };
  "updates.status": UpdateStatus;
  "updates.check": UpdateStatus;
  "updates.install": null;
}
export interface Bridge {
  invoke<K extends Command>(command: K, input: Inputs[K]): Promise<Outputs[K]>;
  subscribe(listener: (dataChanged: boolean) => void): () => void;
  stageFiles(files: File[], peer_id: string): Promise<StagedAttachment[]>;
  onChatPeer(listener: (peer_id: string) => void): () => void;
  onTransfer(listener: (progress: TransferProgress) => void): () => void;
}
export type Result<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };
export interface Credentials {
  user: User;
  access_token: string;
  refresh_token: string;
  expiresAt: number;
}
export interface Vault {
  current: Credentials | null;
  revocations: string[];
}
export type SyncOperation = Required<ApiSchemas["SyncOperation"]>;
export interface OperationResult {
  operation_id: string;
  status: "applied" | "conflict" | "rejected";
  entity?: Entity | null;
  code?: string | null;
  message?: string | null;
}
export interface Change {
  sequence: number;
  kind: string;
  entity_id: string;
  payload: Record<string, unknown>;
}
export interface Pull {
  cursor: number;
  has_more: boolean;
  changes: Change[];
}
