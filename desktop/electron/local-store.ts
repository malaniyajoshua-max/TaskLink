import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  projectBodySchema,
  taskBodySchema,
  taskBatchSchema,
  taskStatusSchema,
  type Change,
  type Conflict,
  type Entity,
  type Kind,
  type Note,
  type OperationResult,
  type Preferences,
  type SyncOperation,
  type Task,
  type TaskBody,
  type Message,
} from "../shared/contract";
import { messageSchema } from "../shared/chat";
import { AppError } from "./errors";
import { StorageCipher } from "./storage-crypto";

interface Row {
  id: string;
  kind: Kind;
  snapshot: string;
  server: string | null;
  generation: number;
}
interface StatusReceipt {
  id: string;
  taskId: string;
  changes: {
    id: string;
    before: TaskBody["status"];
    after: TaskBody["status"];
  }[];
}
interface QueueRow {
  sequence: number;
  operation_id: string;
  entity_id: string;
  generation: number;
  action: "upsert" | "delete";
  payload: string;
  prepared: string | null;
  state: string;
  error: string | null;
  attempts: number;
  next_retry: number;
}
const parse = <T>(json: string): T => JSON.parse(json) as T;
export function effective(task: Task, tasks: Task[]): TaskBody {
  const parent = tasks.find((t) => t.id === task.body.parent_id);
  const body = { ...task.body };
  if (parent)
    for (const [flag, key] of [
      ["inherit_due", "due_at"],
      ["inherit_reminder", "reminder_at"],
      ["inherit_priority", "priority"],
    ] as const) {
      if (body[flag])
        (body as unknown as Record<string, unknown>)[key] = parent.body[key];
    }
  return body;
}
export class LocalStore {
  readonly db: DatabaseSync;
  readonly cipher: StorageCipher;
  private documentsCache: Map<string, Entity> | null = null;
  private visibleCache = new Map<Kind, Entity[]>();
  private documentWrites: Map<string, Entity | null> | null = null;
  constructor(
    readonly filename: string,
    readonly userId: string,
    encryptionKey: Buffer,
  ) {
    this.cipher = new StorageCipher(encryptionKey, userId);
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, snapshot TEXT NOT NULL, server TEXT, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
        entity_id TEXT NOT NULL, generation INTEGER NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, prepared TEXT,
        state TEXT NOT NULL DEFAULT 'pending', error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_retry INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS outbox_entity_sequence ON outbox(entity_id,sequence);
      CREATE TABLE IF NOT EXISTS mirror (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_uploads (id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, size INTEGER NOT NULL, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_upload_chunks (attachment_id TEXT NOT NULL REFERENCES chat_uploads(id) ON DELETE CASCADE, number INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(attachment_id,number));
    `);
    try {
      const rawMeta = (key: string) =>
        (
          this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
            { value: string } | undefined
        )?.value;
      const owner = rawMeta("owner");
      if (owner && JSON.parse(owner) !== userId)
        throw new AppError("wrong_account", "本地数据库属于其他账号");
      const schema = JSON.parse(rawMeta("schema") ?? "1");
      if (![1, 2].includes(schema))
        throw new AppError("schema_version", "本地数据库版本不受支持");
      if (
        schema === 2 &&
        this.meta<string>("keyCheck", "") !== "TaskLink encrypted storage v2"
      )
        throw new AppError(
          "storage_key",
          "数据库密钥校验失败；请保留原文件并从加密备份恢复",
        );
      const columns = new Set(
        this.db
          .prepare("PRAGMA table_info(documents)")
          .all()
          .map((r) => r.name),
      );
      const mirrorColumns = new Set(
        this.db
          .prepare("PRAGMA table_info(mirror)")
          .all()
          .map((row) => row.name),
      );
      this.transaction(() => {
        if (!columns.has("parent_id"))
          this.db.exec(
            "ALTER TABLE documents ADD COLUMN parent_id TEXT; ALTER TABLE documents ADD COLUMN project_id TEXT; ALTER TABLE documents ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;",
          );
        if (!columns.has("reminder_at"))
          this.db.exec(
            "ALTER TABLE documents ADD COLUMN reminder_at TEXT; ALTER TABLE documents ADD COLUMN status TEXT; ALTER TABLE documents ADD COLUMN inherit_reminder INTEGER NOT NULL DEFAULT 0;",
          );
        if (schema === 1) {
          for (const [table, fields] of [
            ["documents", ["snapshot", "server"]],
            ["outbox", ["payload", "prepared", "error"]],
            ["mirror", ["json"]],
            ["reminders", ["json"]],
            ["meta", ["value"]],
          ] as const) {
            for (const row of this.db
              .prepare("SELECT rowid AS _rowid,* FROM " + table)
              .all()) {
              if (
                table === "meta" &&
                ["owner", "schema"].includes(String(row.key))
              )
                continue;
              for (const field of fields)
                if (row[field] !== null)
                  this.db
                    .prepare(`UPDATE ${table} SET ${field}=? WHERE rowid=?`)
                    .run(this.encode(String(row[field])), row._rowid);
            }
          }
          this.setMeta("keyCheck", "TaskLink encrypted storage v2");
        }
        this.setMeta("owner", userId);
        this.setMeta("schema", 2);
        if (!mirrorColumns.has("peer_id")) {
          this.db.exec(
            "ALTER TABLE mirror ADD COLUMN peer_id TEXT; ALTER TABLE mirror ADD COLUMN created_at TEXT;",
          );
          this.rebuildMessageIndexes();
        }
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS mirror_chat_page ON mirror(kind,peer_id,created_at DESC,id DESC)",
        );
        if (!columns.has("parent_id") || !columns.has("reminder_at"))
          this.rebuildIndexes();
        this.db.exec(
          "CREATE INDEX IF NOT EXISTS documents_parent ON documents(parent_id,deleted); CREATE INDEX IF NOT EXISTS documents_project ON documents(project_id,deleted); CREATE INDEX IF NOT EXISTS documents_kind_live ON documents(kind,deleted); CREATE INDEX IF NOT EXISTS outbox_state ON outbox(state,sequence);",
        );
      });
      if (schema === 1) {
        this.db.exec(
          "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
        );
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  encode(value: string) {
    return this.cipher.seal(value);
  }
  decode(value: string) {
    return this.cipher.open(value);
  }
  private decodeRow(row: Row): Row {
    return {
      ...row,
      snapshot: this.decode(row.snapshot),
      server: row.server === null ? null : this.decode(row.server),
    };
  }
  private decodeQueue(row: QueueRow): QueueRow {
    return {
      ...row,
      payload: this.decode(row.payload),
      prepared: row.prepared === null ? null : this.decode(row.prepared),
      error: row.error === null ? null : this.decode(row.error),
    };
  }
  rebuildIndexes() {
    this.rebuildMessageIndexes();
    const stmt = this.db.prepare(
      "UPDATE documents SET parent_id=?,project_id=?,deleted=?,reminder_at=?,status=?,inherit_reminder=? WHERE id=?",
    );
    for (const row of this.rows()) {
      const entity = parse<Entity<TaskBody>>(row.snapshot);
      stmt.run(
        entity.kind === "task" ? entity.body.parent_id : null,
        entity.kind === "task" ? entity.body.project_id : null,
        Number(entity.deleted),
        entity.kind === "task" ? entity.body.reminder_at : null,
        entity.kind === "task" ? entity.body.status : null,
        entity.kind === "task" ? Number(entity.body.inherit_reminder) : 0,
        entity.id,
      );
    }
  }
  private rebuildMessageIndexes() {
    const update = this.db.prepare(
      "UPDATE mirror SET peer_id=?,created_at=? WHERE kind='message' AND id=?",
    );
    for (const message of this.allMirror<Message>("message")) {
      const value = messageSchema.parse(message);
      update.run(
        value.sender_id === this.userId ? value.recipient_id : value.sender_id,
        value.created_at,
        value.id,
      );
    }
  }
  close() {
    this.invalidateDocuments();
    this.db.close();
    this.cipher.key.fill(0);
  }
  invalidateDocuments() {
    this.documentsCache = null;
    this.visibleCache.clear();
  }
  private changedDocument(id: string, entity: Entity | null) {
    if (this.documentWrites) this.documentWrites.set(id, entity);
    else {
      if (entity) this.documentsCache?.set(id, entity);
      else this.documentsCache?.delete(id);
      this.visibleCache.clear();
    }
  }
  private erase(id: string) {
    this.db.prepare("DELETE FROM documents WHERE id=?").run(id);
    this.changedDocument(id, null);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    this.documentWrites = new Map();
    try {
      const result = fn();
      this.db.exec("COMMIT");
      for (const [id, entity] of this.documentWrites) {
        if (entity) this.documentsCache?.set(id, entity);
        else this.documentsCache?.delete(id);
      }
      if (this.documentWrites.size) this.visibleCache.clear();
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.documentWrites = null;
    }
  }
  meta<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row
      ? parse<T>(
          ["owner", "schema"].includes(key)
            ? row.value
            : this.decode(row.value),
        )
      : fallback;
  }
  setMeta(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)")
      .run(
        key,
        ["owner", "schema"].includes(key)
          ? JSON.stringify(value)
          : this.encode(JSON.stringify(value)),
      );
  }
  rows(): Row[] {
    return (
      this.db.prepare("SELECT * FROM documents").all() as unknown as Row[]
    ).map((r) => this.decodeRow(r));
  }
  row(id: string) {
    const row = this.db
      .prepare("SELECT * FROM documents WHERE id=?")
      .get(id) as Row | undefined;
    return row ? this.decodeRow(row) : undefined;
  }
  entity<T extends Entity>(id: string | null): T | undefined {
    const row = id ? this.row(id) : undefined;
    const entity = row ? parse<T>(row.snapshot) : undefined;
    return entity && !entity.deleted ? entity : undefined;
  }
  entities<T extends Entity>(kind: Kind): T[] {
    // Only committed snapshots are cached, inside the data worker. Transactions
    // query SQLite so rollback never publishes uncommitted data to the UI.
    if (!this.documentWrites) {
      if (!this.documentsCache)
        this.documentsCache = new Map(
          (
            this.db.prepare("SELECT id,snapshot FROM documents").all() as {
              id: string;
              snapshot: string;
            }[]
          ).map((row) => [row.id, parse<Entity>(this.decode(row.snapshot))]),
        );
      let visible = this.visibleCache.get(kind);
      if (!visible) {
        visible = [...this.documentsCache.values()].filter(
          (entity) =>
            entity.kind === kind &&
            !entity.deleted &&
            (kind !== "task" ||
              ![
                (entity.body as TaskBody).parent_id,
                (entity.body as TaskBody).project_id,
              ].some((id) => id && this.documentsCache!.get(id)?.deleted)),
        );
        this.visibleCache.set(kind, visible);
      }
      return visible as T[];
    }
    return (
      this.db
        .prepare(
          `SELECT d.* FROM documents d WHERE d.kind=? AND d.deleted=0
      AND NOT EXISTS(SELECT 1 FROM documents p WHERE p.id=d.parent_id AND p.deleted=1)
      AND NOT EXISTS(SELECT 1 FROM documents p WHERE p.id=d.project_id AND p.deleted=1)`,
        )
        .all(kind) as unknown as Row[]
    ).map((r) => parse<T>(this.decode(r.snapshot)));
  }
  children(id: string, project = false): Task[] {
    return (
      this.db
        .prepare(
          "SELECT snapshot FROM documents WHERE deleted=0 AND " +
            (project ? "project_id" : "parent_id") +
            "=?",
        )
        .all(id) as { snapshot: string }[]
    ).map((r) => parse<Task>(this.decode(r.snapshot)));
  }
  allMirror<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT json FROM mirror WHERE kind=?")
        .all(kind) as unknown as { json: string }[]
    ).map((r) => parse<T>(this.decode(r.json)));
  }
  mirror(kind: string, id: string, value: unknown) {
    const item = kind === "message" ? messageSchema.parse(value) : null;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO mirror(kind,id,json,peer_id,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        kind,
        id,
        this.encode(JSON.stringify(value)),
        item
          ? item.sender_id === this.userId
            ? item.recipient_id
            : item.sender_id
          : null,
        item?.created_at ?? null,
      );
  }
  message(id: string): Message | undefined {
    const row = this.db
      .prepare("SELECT json FROM mirror WHERE kind='message' AND id=?")
      .get(id);
    return row
      ? messageSchema.parse(JSON.parse(this.decode(String(row.json))))
      : undefined;
  }
  messages(
    peer: string,
    limit = 100,
    before?: { created_at: string; id: string },
  ): Message[] {
    const rows = before
      ? this.db
          .prepare(
            "SELECT json FROM mirror WHERE kind='message' AND peer_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?",
          )
          .all(peer, before.created_at, before.id, limit)
      : this.db
          .prepare(
            "SELECT json FROM mirror WHERE kind='message' AND peer_id=? ORDER BY created_at DESC,id DESC LIMIT ?",
          )
          .all(peer, limit);
    return rows
      .reverse()
      .map((row) =>
        messageSchema.parse(JSON.parse(this.decode(String(row.json)))),
      );
  }
  conversations() {
    return this.db
      .prepare("SELECT DISTINCT peer_id FROM mirror WHERE kind='message'")
      .all()
      .map((row) => {
        const peer_id = String(row.peer_id);
        return { peer_id, last: this.messages(peer_id, 1)[0] };
      });
  }
  put(entity: Entity, generation: number, server: string | null) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO documents(id,kind,snapshot,server,generation,parent_id,project_id,deleted,reminder_at,status,inherit_reminder) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        entity.id,
        entity.kind,
        this.encode(JSON.stringify(entity)),
        server === null ? null : this.encode(server),
        generation,
        entity.kind === "task" ? (entity.body as TaskBody).parent_id : null,
        entity.kind === "task" ? (entity.body as TaskBody).project_id : null,
        Number(entity.deleted),
        entity.kind === "task" ? (entity.body as TaskBody).reminder_at : null,
        entity.kind === "task" ? (entity.body as TaskBody).status : null,
        entity.kind === "task"
          ? Number((entity.body as TaskBody).inherit_reminder)
          : 0,
      );
    this.changedDocument(entity.id, entity);
  }
  private validateTask(task: Task) {
    const parent = this.entity<Task>(task.body.parent_id);
    if (
      task.body.parent_id &&
      (!parent ||
        parent.id === task.id ||
        parent.body.parent_id ||
        parent.workspace_id !== task.workspace_id ||
        parent.body.project_id !== task.body.project_id)
    )
      throw new AppError(
        "invalid_parent",
        "父子任务必须属于同一项目；当前支持一级子任务",
      );
    if (task.body.project_id) {
      const project = this.entity(task.body.project_id);
      if (!project || project.workspace_id !== task.workspace_id)
        throw new AppError("invalid_project", "项目不存在或不属于当前工作区");
    }
    const validate = (body: TaskBody, parentDue?: string | null) => {
      if (
        (body.start_at && body.due_at && body.start_at > body.due_at) ||
        (body.reminder_at && body.due_at && body.reminder_at > body.due_at) ||
        (parentDue && body.due_at && body.due_at > parentDue)
      )
        throw new AppError(
          "invalid_dates",
          "请检查开始、截止与提醒时间，子任务截止时间不能晚于父任务",
        );
    };
    validate(effective(task, parent ? [parent] : []), parent?.body.due_at);
    for (const child of this.children(task.id)) {
      if (task.body.parent_id)
        throw new AppError("nesting_limit", "包含子任务的任务不能再成为子任务");
      if (child.body.project_id !== task.body.project_id)
        throw new AppError(
          "children_scope",
          "请先处理子任务，再移动父任务项目",
        );
      validate(effective(child, [task]), task.body.due_at);
    }
  }
  private saveInner(
    kind: Kind,
    body: unknown,
    workspaceId: string | null,
    entityId?: string,
    deleting = false,
  ): Entity {
    const previous = entityId ? this.row(entityId) : undefined;
    if (entityId && !previous)
      throw new AppError("missing_entity", "本地记录不存在");
    const old = previous ? parse<Entity>(previous.snapshot) : undefined;
    if (old && (old.kind !== kind || old.workspace_id !== workspaceId))
      throw new AppError("scope_changed", "不能改变记录类型或工作区");
    if (workspaceId) {
      const ws = this.allMirror<{ id: string; role: string; deleted: boolean }>(
        "workspace",
      ).find((w) => w.id === workspaceId && !w.deleted);
      if (!ws || ws.role === "viewer")
        throw new AppError("forbidden", "当前角色不能编辑工作区记录");
    }
    const validated =
      kind === "task"
        ? taskBodySchema.parse(body)
        : projectBodySchema.parse(body);
    const entity: Entity = {
      id: entityId ?? randomUUID(),
      kind,
      body: validated,
      workspace_id: workspaceId,
      owner_id: old?.owner_id ?? this.userId,
      version: old?.version ?? 0,
      deleted: deleting,
      updated_at: new Date().toISOString(),
    };
    if (!deleting && kind === "task") this.validateTask(entity as Task);
    const generation = (previous?.generation ?? 0) + 1;
    this.put(entity, generation, previous?.server ?? null);
    const tail = this.entityQueue(entity.id, true)[0];
    const confirmed = previous?.server
      ? parse<Entity>(previous.server).version
      : 0;
    const baseVersion = tail?.prepared
      ? parse<SyncOperation>(tail.prepared).base_version + 1
      : confirmed;
    const operation: SyncOperation = {
      operation_id: randomUUID(),
      entity_id: entity.id,
      entity_type: kind,
      workspace_id: workspaceId,
      action: deleting ? "delete" : "upsert",
      base_version: baseVersion,
      payload: validated,
    };
    this.db
      .prepare(
        "INSERT INTO outbox(operation_id,entity_id,generation,action,payload,prepared) VALUES(?,?,?,?,?,?)",
      )
      .run(
        operation.operation_id,
        entity.id,
        generation,
        operation.action,
        this.encode(JSON.stringify(validated)),
        this.encode(JSON.stringify(operation)),
      );
    return entity;
  }
  save(
    kind: Kind,
    body: unknown,
    workspaceId: string | null,
    entityId?: string,
  ) {
    return this.transaction(() => {
      const previous = entityId ? this.entity<Task>(entityId) : undefined;
      const entity = this.saveInner(kind, body, workspaceId, entityId);
      if (kind === "task") this.linkTaskStatus(entity as Task, previous);
      return this.entity(entity.id)!;
    });
  }
  private taskFamily(task: Task): Task[] {
    const parent = task.body.parent_id
      ? this.entity<Task>(task.body.parent_id)
      : task;
    return parent ? [parent, ...(this.children(parent.id) as Task[])] : [task];
  }
  private writeStatus(task: Task, status: TaskBody["status"]) {
    if (task.body.status !== status)
      this.saveInner(
        "task",
        { ...task.body, status },
        task.workspace_id,
        task.id,
      );
  }
  private refreshParentStatus(parentId: string) {
    const parent = this.entity<Task>(parentId);
    const children = this.children(parentId) as Task[];
    if (!parent || !children.length) return;
    if (children.every((child) => child.body.status === "done"))
      this.writeStatus(parent, "done");
    else if (parent.body.status === "done")
      this.writeStatus(parent, "in_progress");
  }
  /**
   * Apply one user intent to the family inside the caller's transaction. Derived
   * writes use saveInner directly so completing the first child cannot recursively
   * complete its siblings. Each changed record retains its own sync version;
   * concurrent remote edits still go through the existing conflict review.
   */
  private linkTaskStatus(task: Task, previous?: Task) {
    if (task.body.parent_id) {
      this.refreshParentStatus(task.body.parent_id);
      return;
    }
    if (task.body.status === "done") {
      for (const child of this.children(task.id) as Task[])
        this.writeStatus(child, "done");
    } else if (previous?.body.status === "done") {
      for (const child of this.children(task.id) as Task[])
        this.writeStatus(child, "todo");
    }
  }
  /**
   * Read, check and update a status in one transaction. Doing this as separate
   * renderer calls leaves a gap in which sync can replace the task snapshot.
   * Optional expectedStatus supports callers with a precondition. The UI receives
   * a separate family receipt for undo; other fields come from current storage.
   */
  setTaskStatus(input: unknown): {
    task: Task;
    previous: TaskBody["status"];
    undoId: string | null;
    changedCount: number;
  } {
    const { id, status, expectedStatus } = taskStatusSchema.parse(input);
    return this.transaction(() => {
      const task = this.entity<Task>(id);
      if (!task || task.kind !== "task")
        throw new AppError("missing_entity", "任务已被删除，请刷新列表。");
      const previous = task.body.status;
      if (expectedStatus !== undefined && previous !== expectedStatus)
        throw new AppError(
          "status_changed",
          "任务状态已有新的更改，请打开任务确认。",
        );
      if (previous === status)
        return { task, previous, undoId: null, changedCount: 0 };
      const before = this.taskFamily(task);
      const saved = this.saveInner(
        "task",
        { ...task.body, status },
        task.workspace_id,
        id,
      ) as Task;
      this.linkTaskStatus(saved, task);
      const after = this.taskFamily(saved);
      const undoId = randomUUID();
      const changes = before.map((item) => ({
        id: item.id,
        before: item.body.status,
        after: after.find((updated) => updated.id === item.id)!.body.status,
      }));
      // Keep a bounded, encrypted receipt rather than trusting a renderer-supplied
      // family snapshot. Unchanged siblings are guards too: their later edits must
      // prevent undo from leaving a completed parent above an unfinished child.
      const receipts = this.meta<StatusReceipt[]>("statusUndo", []);
      this.setMeta("statusUndo", [
        ...receipts.slice(-19),
        { id: undoId, taskId: id, changes },
      ]);
      return {
        task: this.entity<Task>(id)!,
        previous,
        undoId,
        changedCount: changes.filter((item) => item.before !== item.after)
          .length,
      };
    });
  }
  undoTaskStatus(id: string) {
    return this.transaction(() => {
      const receipts = this.meta<StatusReceipt[]>("statusUndo", []);
      const receipt = receipts.find((item) => item.id === id);
      const task = receipt && this.entity<Task>(receipt.taskId);
      if (!receipt || !task)
        throw new AppError("undo_expired", "撤销记录已失效，请打开任务确认。");
      const family = this.taskFamily(task);
      if (
        family.length !== receipt.changes.length ||
        receipt.changes.some(
          (change) =>
            !family.some(
              (item) =>
                item.id === change.id && item.body.status === change.after,
            ),
        )
      )
        throw new AppError(
          "status_changed",
          "父子任务的状态或成员已有更改，未执行撤销。",
        );
      for (const change of receipt.changes)
        this.writeStatus(this.entity<Task>(change.id)!, change.before);
      this.setMeta(
        "statusUndo",
        receipts.filter((item) => item.id !== id),
      );
      return this.entity<Task>(task.id)!;
    });
  }
  /**
   * Every selected task and its Outbox operation commits together. saveInner
   * performs the same role/reference checks as an individual edit; one failure
   * rolls back the batch, including cache changes staged by transaction().
   */
  batchTasks(input: unknown): Task[] {
    const { ids, patch } = taskBatchSchema.parse(input);
    return this.transaction(() =>
      [...new Set(ids)].map((entityId) => {
        const task = this.entity<Task>(entityId);
        if (!task || task.kind !== "task" || task.deleted)
          throw new AppError(
            "missing_entity",
            "所选任务已被删除，请刷新后重试",
          );
        const body = { ...task.body, ...patch };
        // An explicit batch value overrides inheritance. Otherwise the stored
        // value would change while the UI continued to display the parent's value.
        if ("due_at" in patch) body.inherit_due = false;
        if ("priority" in patch) body.inherit_priority = false;
        if (
          body.start_at &&
          body.due_at &&
          new Date(body.start_at) > new Date(body.due_at)
        )
          throw new AppError(
            "invalid_date",
            `「${body.title}」的截止时间早于开始时间，未修改任何任务`,
          );
        const saved = this.saveInner(
          "task",
          body,
          task.workspace_id,
          task.id,
        ) as Task;
        this.linkTaskStatus(saved, task);
        return this.entity<Task>(task.id)!;
      }),
    );
  }
  /**
   * Copy a task tree atomically with fresh IDs. A copied child becomes a root,
   * so materialize inherited due/priority values before removing its parent.
   * Clear reminders to avoid re-sending the source task's past notifications.
   */
  duplicateTask(entityId: string): Task {
    return this.transaction(() => {
      const task = this.entity<Task>(entityId);
      if (!task || task.kind !== "task" || task.deleted)
        throw new AppError("missing_entity", "任务已被删除，无法复制");
      const parent = task.body.parent_id
        ? this.entity<Task>(task.body.parent_id)
        : null;
      const copy = this.saveInner(
        "task",
        {
          ...task.body,
          title: task.body.title.slice(0, 235) + "（副本）",
          status: "todo",
          parent_id: null,
          reminder_at: null,
          inherit_due: false,
          inherit_priority: false,
          inherit_reminder: false,
          due_at:
            parent && task.body.inherit_due
              ? parent.body.due_at
              : task.body.due_at,
          priority:
            parent && task.body.inherit_priority
              ? parent.body.priority
              : task.body.priority,
        },
        task.workspace_id,
      ) as Task;
      if (!task.body.parent_id)
        for (const child of this.children(task.id, false)) {
          this.saveInner(
            "task",
            {
              ...child.body,
              parent_id: copy.id,
              status: "todo",
              reminder_at: null,
              inherit_reminder: false,
            },
            task.workspace_id,
          );
        }
      return copy;
    });
  }
  remove(entityId: string) {
    this.transaction(() => {
      const row = this.row(entityId);
      if (!row) throw new AppError("missing_entity", "记录不存在");
      const entity = parse<Entity>(row.snapshot);
      // Cascade local deletion. The server performs the same cascade in one transaction.
      const children = this.children(entityId, entity.kind === "project");
      for (const child of children) {
        const childRow = this.row(child.id)!;
        this.put(
          { ...child, deleted: true },
          childRow.generation,
          childRow.server,
        );
        // Local child operations must be resolved before sending the parent deletion.
      }
      this.saveInner(
        entity.kind,
        entity.body,
        entity.workspace_id,
        entity.id,
        true,
      );
      if (entity.kind === "task" && (entity as Task).body.parent_id)
        this.refreshParentStatus((entity as Task).body.parent_id!);
    });
  }
  queue(): QueueRow[] {
    return (
      this.db
        .prepare("SELECT * FROM outbox ORDER BY sequence")
        .all() as unknown as QueueRow[]
    ).map((r) => this.decodeQueue(r));
  }
  entityQueue(id: string, last = false): QueueRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM outbox WHERE entity_id=? ORDER BY sequence " +
            (last ? "DESC LIMIT 1" : "ASC"),
        )
        .all(id) as unknown as QueueRow[]
    ).map((r) => this.decodeQueue(r));
  }
  private operation(id: string): QueueRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM outbox WHERE operation_id=?")
      .get(id) as unknown as QueueRow | undefined;
    return row ? this.decodeQueue(row) : undefined;
  }
  pendingCount() {
    return Number(this.db.prepare("SELECT count(*) AS n FROM outbox").get()!.n);
  }
  queueStats() {
    const row = this.db
      .prepare(
        "SELECT count(*) AS pending,coalesce(sum(state='conflict'),0) AS conflicts,min(CASE WHEN next_retry>? THEN next_retry END) AS retry FROM outbox",
      )
      .get(Date.now())!;
    return {
      pending: Number(row.pending),
      conflicts: Number(row.conflicts),
      nextRetry: row.retry === null ? null : Number(row.retry),
    };
  }
  prepareBatch(force = false): SyncOperation[] {
    return this.transaction(() => {
      const selected: SyncOperation[] = [];
      const ready = this.db
        .prepare(
          `SELECT q.* FROM outbox q WHERE q.state IN ('pending','sending') AND (? OR q.next_retry<=?)
        AND NOT EXISTS(SELECT 1 FROM outbox earlier WHERE earlier.entity_id=q.entity_id AND earlier.sequence<q.sequence)
        ORDER BY q.sequence LIMIT 100`,
        )
        .all(Number(force), Date.now()) as unknown as QueueRow[];
      for (const encrypted of ready) {
        const row = this.decodeQueue(encrypted);
        const local = this.row(row.entity_id)!;
        const entity = parse<Entity>(local.snapshot);
        const server = local.server ? parse<Entity>(local.server) : null;
        const op: SyncOperation = row.prepared
          ? parse(row.prepared)
          : {
              operation_id: row.operation_id,
              entity_id: row.entity_id,
              entity_type: local.kind,
              workspace_id: entity.workspace_id,
              action: row.action,
              payload: parse(row.payload),
              base_version: server?.version ?? 0,
            };
        this.db
          .prepare(
            "UPDATE outbox SET prepared=?,state='sending' WHERE operation_id=?",
          )
          .run(this.encode(JSON.stringify(op)), row.operation_id);
        selected.push(op);
        if (selected.length === 100) break;
      }
      return selected;
    });
  }
  retry(operations: SyncOperation[]) {
    this.transaction(() => {
      for (const op of operations) {
        const row = this.operation(op.operation_id);
        if (!row) continue;
        const delay =
          Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6)) +
          Math.floor(Math.random() * 500);
        this.db
          .prepare(
            "UPDATE outbox SET attempts=attempts+1,next_retry=? WHERE operation_id=?",
          )
          .run(Date.now() + delay, op.operation_id);
      }
    });
  }
  acknowledge(results: OperationResult[]) {
    this.transaction(() => {
      for (const result of results) {
        const queued = this.operation(result.operation_id);
        if (!queued) continue;
        const row = this.row(queued.entity_id)!;
        const oldServer = row.server ? parse<Entity>(row.server) : null;
        const remote = result.entity;
        if (remote && (!oldServer || remote.version >= oldServer.version))
          this.db
            .prepare("UPDATE documents SET server=? WHERE id=?")
            .run(this.encode(JSON.stringify(remote)), row.id);
        if (result.status === "applied" && remote) {
          this.db
            .prepare("DELETE FROM outbox WHERE operation_id=?")
            .run(result.operation_id);
          if (!this.entityQueue(row.id, true).length) {
            const latest =
              oldServer && oldServer.version > remote.version
                ? oldServer
                : remote;
            this.put(latest, row.generation, JSON.stringify(latest));
          }
        } else
          this.db
            .prepare(
              "UPDATE outbox SET state='conflict',error=? WHERE operation_id=?",
            )
            .run(
              this.encode(
                JSON.stringify({
                  code: result.code,
                  message: result.message,
                  remote: remote ?? null,
                }),
              ),
              result.operation_id,
            );
      }
    });
  }
  applyChanges(changes: Change[], cursor: number) {
    this.transaction(() => {
      for (const change of changes) {
        const p = change.payload;
        if (change.kind === "task" || change.kind === "project") {
          const row = this.row(change.entity_id);
          if (p.revoked) {
            const pending = this.entityQueue(change.entity_id, true);
            if (row && pending.length) {
              this.db
                .prepare("UPDATE documents SET server=NULL WHERE id=?")
                .run(change.entity_id);
              this.db
                .prepare(
                  "UPDATE outbox SET state='conflict',error=? WHERE operation_id=?",
                )
                .run(
                  this.encode(
                    JSON.stringify({
                      code: "access_revoked",
                      message: "工作区访问权限已撤销；本地改动可另存为个人记录",
                      remote: null,
                    }),
                  ),
                  pending[0].operation_id,
                );
            } else this.erase(change.entity_id);
            continue;
          }
          const entity = p as unknown as Entity;
          const server = row?.server ? parse<Entity>(row.server) : null;
          if (server && server.version > entity.version) continue;
          const pending = this.entityQueue(entity.id, true);
          if (row && pending.length) {
            this.db
              .prepare("UPDATE documents SET server=? WHERE id=?")
              .run(this.encode(JSON.stringify(entity)), entity.id);
            if (entity.deleted)
              this.db
                .prepare(
                  "UPDATE outbox SET state='conflict',error=? WHERE operation_id=?",
                )
                .run(
                  this.encode(
                    JSON.stringify({
                      code: "remote_deleted",
                      message:
                        "服务器已删除此记录，可以另存为个人记录或接受删除",
                      remote: entity,
                    }),
                  ),
                  pending[0].operation_id,
                );
          } else this.put(entity, row?.generation ?? 0, JSON.stringify(entity));
        } else if (p.revoked || p.deleted) {
          if (change.kind === "workspace")
            this.db
              .prepare("DELETE FROM meta WHERE key=?")
              .run("members:" + change.entity_id);
          this.db
            .prepare("DELETE FROM mirror WHERE kind=? AND id=?")
            .run(change.kind, change.entity_id);
        } else this.mirror(change.kind, change.entity_id, p);
      }
      this.setMeta("cursor", cursor);
    });
  }
  conflicts(): Conflict[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM outbox WHERE state='conflict' ORDER BY sequence",
        )
        .all() as unknown as QueueRow[]
    )
      .map((r) => this.decodeQueue(r))
      .map((r) => {
        const err = r.error
          ? parse<{ code: string; message: string; remote: Entity | null }>(
              r.error,
            )
          : { code: "conflict", message: "需要处理冲突", remote: null };
        const row = this.row(r.entity_id)!;
        return {
          operation_id: r.operation_id,
          entity_id: r.entity_id,
          local: parse<Entity>(row.snapshot),
          ...err,
        };
      });
  }
  resolve(operationId: string, choice: "server" | "local" | "copy") {
    this.transaction(() => {
      const item = this.conflicts().find((c) => c.operation_id === operationId);
      if (!item) throw new AppError("missing_conflict", "冲突已处理");
      const row = this.row(item.entity_id)!;
      const latest = row.server ? parse<Entity>(row.server) : item.remote;
      if (choice === "local" && (!latest || latest.deleted))
        throw new AppError("remote_deleted", "请另存为新记录或采用服务器版本");
      this.db
        .prepare("DELETE FROM outbox WHERE entity_id=?")
        .run(item.entity_id);
      if (latest) this.put(latest, row.generation, JSON.stringify(latest));
      else this.erase(item.entity_id);
      if (choice === "local")
        this.saveInner(
          item.local.kind,
          item.local.body,
          item.local.workspace_id,
          item.entity_id,
          item.local.deleted,
        );
      if (choice === "copy") {
        const body =
          item.local.kind === "task"
            ? {
                ...item.local.body,
                project_id: null,
                parent_id: null,
                assignee_id: null,
              }
            : item.local.body;
        this.saveInner(item.local.kind, body, null);
      }
    });
  }
  preferences(): Preferences {
    return this.meta("preferences", {
      theme: "system",
      notifications: true,
      closeToTray: true,
      notificationPreview: false,
    });
  }
  validateAll() {
    for (const task of this.entities<Task>("task")) this.validateTask(task);
  }
  notifications(): Note[] {
    return [
      ...this.allMirror<Note>("notification"),
      ...(
        this.db.prepare("SELECT json FROM reminders").all() as unknown as {
          json: string;
        }[]
      ).map((r) => parse<Note>(this.decode(r.json))),
    ].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  dueReminders(): Note[] {
    return this.transaction(() => {
      const notes: Note[] = [];
      const candidates = this.db
        .prepare(
          `SELECT d.snapshot,p.snapshot AS parent_snapshot FROM documents d
        LEFT JOIN documents p ON p.id=d.parent_id LEFT JOIN documents project ON project.id=d.project_id
        WHERE d.kind='task' AND d.deleted=0 AND d.status<>'done' AND coalesce(p.deleted,0)=0 AND coalesce(project.deleted,0)=0
        AND (CASE WHEN d.inherit_reminder=1 AND p.id IS NOT NULL THEN p.reminder_at ELSE d.reminder_at END)<=?
        AND NOT EXISTS(SELECT 1 FROM deliveries WHERE id=d.id || ':' || (CASE WHEN d.inherit_reminder=1 AND p.id IS NOT NULL THEN p.reminder_at ELSE d.reminder_at END))`,
        )
        .all(new Date().toISOString()) as {
        snapshot: string;
        parent_snapshot: string | null;
      }[];
      for (const candidate of candidates) {
        const task = parse<Task>(this.decode(candidate.snapshot));
        const parent = candidate.parent_snapshot
          ? parse<Task>(this.decode(candidate.parent_snapshot))
          : undefined;
        const body = effective(task, parent ? [parent] : []);
        if (
          body.status === "done" ||
          !body.reminder_at ||
          new Date(body.reminder_at).getTime() > Date.now()
        )
          continue;
        const delivery = task.id + ":" + body.reminder_at;
        if (
          this.db.prepare("SELECT id FROM deliveries WHERE id=?").get(delivery)
        )
          continue;
        const note: Note = {
          id: randomUUID(),
          title: "任务提醒",
          body: body.title,
          read: false,
          created_at: new Date().toISOString(),
          local: true,
        };
        this.db.prepare("INSERT INTO deliveries(id) VALUES(?)").run(delivery);
        this.db
          .prepare("INSERT INTO reminders(id,json) VALUES(?,?)")
          .run(note.id, this.encode(JSON.stringify(note)));
        notes.push(note);
      }
      return notes;
    });
  }
  readLocalNote(id: string): Note | null {
    const row = this.db
      .prepare("SELECT json FROM reminders WHERE id=?")
      .get(id) as { json: string } | undefined;
    if (!row) return null;
    const note = { ...parse<Note>(this.decode(row.json)), read: true };
    this.db
      .prepare("UPDATE reminders SET json=? WHERE id=?")
      .run(this.encode(JSON.stringify(note)), id);
    return note;
  }
}
