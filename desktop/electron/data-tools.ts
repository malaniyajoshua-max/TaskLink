import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { Entity, TaskBody, SyncOperation } from "../shared/contract";
import {
  projectBodySchema,
  taskBodySchema,
  preferencesSchema,
} from "../shared/contract";
import { AppError } from "./errors";
import { LocalStore } from "./local-store";
import { entityResponse, noteResponse, validateMirror } from "./wire";
import { validateChatBackup } from "./chat-store";

const archiveSchema = z
  .object({
    format: z.literal("tasklink-export"),
    version: z.literal(1),
    documents: z
      .array(
        z
          .object({
            id: z.uuid(),
            kind: z.enum(["task", "project"]),
            body: z.unknown(),
          })
          .strict(),
      )
      .max(20000),
  })
  .strict();
export function exportJson(local: LocalStore, filename: string) {
  const documents = [
    ...local.entities("project"),
    ...local.entities("task"),
  ].map(({ id, kind, body }) => ({ id, kind, body }));
  writeFileSync(
    filename,
    JSON.stringify(
      { format: "tasklink-export", version: 1, documents },
      null,
      2,
    ),
    "utf8",
  );
}
export function importJson(local: LocalStore, filename: string) {
  if (statSync(filename).size > 10 * 1024 * 1024)
    throw new AppError("file_too_large", "导入文件不能超过 10 MB");
  const data = archiveSchema.parse(JSON.parse(readFileSync(filename, "utf8")));
  const ids = new Map(data.documents.map((d) => [d.id, randomUUID()]));
  if (ids.size !== data.documents.length)
    throw new AppError("duplicate_id", "导入文件包含重复 ID");
  const validated = data.documents.map((d) => ({
    ...d,
    body:
      d.kind === "task"
        ? taskBodySchema.parse(d.body)
        : projectBodySchema.parse(d.body),
  }));
  // Validate all input first, then perform the entire import in one SQLite transaction.
  local.transaction(() => {
    for (const item of [
      ...validated.filter((d) => d.kind === "project"),
      ...validated.filter(
        (d) => d.kind === "task" && !(d.body as TaskBody).parent_id,
      ),
      ...validated.filter(
        (d) => d.kind === "task" && (d.body as TaskBody).parent_id,
      ),
    ]) {
      const body =
        item.kind === "task"
          ? {
              ...item.body,
              project_id: (item.body as TaskBody).project_id
                ? (ids.get((item.body as TaskBody).project_id!) ?? null)
                : null,
              parent_id: (item.body as TaskBody).parent_id
                ? (ids.get((item.body as TaskBody).parent_id!) ?? null)
                : null,
              assignee_id: null,
            }
          : item.body;
      const entity: Entity = {
        id: ids.get(item.id)!,
        kind: item.kind,
        owner_id: local.userId,
        workspace_id: null,
        body,
        version: 0,
        deleted: false,
        updated_at: new Date().toISOString(),
      };
      local.put(entity, 1, null);
      const op: SyncOperation = {
        operation_id: randomUUID(),
        entity_id: entity.id,
        entity_type: entity.kind,
        workspace_id: null,
        action: "upsert",
        base_version: 0,
        payload: body,
      };
      local.db
        .prepare(
          "INSERT INTO outbox(operation_id,entity_id,generation,action,payload,prepared) VALUES(?,?,1,?,?,?)",
        )
        .run(
          op.operation_id,
          entity.id,
          "upsert",
          local.encode(JSON.stringify(body)),
          local.encode(JSON.stringify(op)),
        );
    }
    local.validateAll();
  });
  return data.documents.length;
}
export function backup(local: LocalStore, filename: string) {
  if (existsSync(filename))
    throw new AppError("backup_exists", "请选择尚不存在的新备份文件名");
  local.db.prepare("VACUUM INTO ?").run(filename);
}
export function restore(local: LocalStore, filename: string) {
  if (statSync(filename).size > 512 * 1024 * 1024)
    throw new AppError("file_too_large", "备份不能超过 512 MB");
  const source = new DatabaseSync(filename, { readOnly: true });
  try {
    const check = source.prepare("PRAGMA integrity_check").get() as Record<
      string,
      string
    >;
    if (Object.values(check)[0] !== "ok")
      throw new AppError("invalid_backup", "备份数据库完整性检查失败");
    const owner = source
      .prepare("SELECT value FROM meta WHERE key='owner'")
      .get() as { value: string } | undefined;
    const schema = source
      .prepare("SELECT value FROM meta WHERE key='schema'")
      .get() as { value: string } | undefined;
    if (
      !owner ||
      JSON.parse(owner.value) !== local.userId ||
      !schema ||
      JSON.parse(schema.value) !== 2
    )
      throw new AppError("wrong_backup", "备份版本或所属账号不匹配");
    const tables = [
      "meta",
      "documents",
      "outbox",
      "mirror",
      "deliveries",
      "reminders",
      "chat_uploads",
      "chat_upload_chunks",
    ] as const;
    const rows = new Map(
      tables.map((table) => [
        table,
        source
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table)
          ? source.prepare("SELECT * FROM " + table).all()
          : [],
      ]),
    );
    // Only fixed columns from our schema are copied; no SQL read from the selected file is executed.
    local.transaction(() => {
      for (const table of [...tables].reverse())
        local.db.exec("DELETE FROM " + table);
      for (const table of tables) {
        const expected = local.db
          .prepare("PRAGMA table_info(" + table + ")")
          .all() as unknown as { name: string }[];
        const columns = expected.map((c) => c.name);
        const stmt = local.db.prepare(
          "INSERT INTO " +
            table +
            "(" +
            columns.join(",") +
            ") VALUES(" +
            columns.map(() => "?").join(",") +
            ")",
        );
        for (const row of rows.get(table)!)
          stmt.run(
            ...columns.map((c) =>
              table === "mirror" && ["peer_id", "created_at"].includes(c)
                ? null
                : row[c],
            ),
          );
      }
      local.rebuildIndexes();
      local.meta("keyCheck", "");
      validateBackupContents(local);
    });
    local.invalidateDocuments();
  } finally {
    source.close();
  }
}

function validateBackupContents(local: LocalStore) {
  validateChatBackup(local);
  const ids = new Set<string>();
  for (const row of local.rows()) {
    const snapshot = JSON.parse(row.snapshot) as Entity;
    for (const entity of [
      snapshot,
      ...(row.server ? [JSON.parse(row.server)] : []),
    ]) {
      entityResponse.parse(entity);
      z.uuid().parse(entity.id);
      z.uuid().parse(entity.owner_id);
      z.uuid().nullable().parse(entity.workspace_id);
      z.number().int().nonnegative().parse(entity.version);
      z.boolean().parse(entity.deleted);
      z.string().datetime({ offset: true }).parse(entity.updated_at);
      if (
        entity.id !== row.id ||
        entity.kind !== row.kind ||
        !["task", "project"].includes(row.kind) ||
        (!entity.workspace_id && entity.owner_id !== local.userId)
      )
        throw new AppError("invalid_backup", "备份记录的身份或类型不匹配");
      (entity.kind === "task" ? taskBodySchema : projectBodySchema).parse(
        entity.body,
      );
    }
    z.number().int().nonnegative().parse(row.generation);
    ids.add(row.id);
  }
  for (const row of local.queue()) {
    z.uuid().parse(row.operation_id);
    z.enum(["pending", "sending", "conflict"]).parse(row.state);
    if (!ids.has(row.entity_id))
      throw new AppError("invalid_backup", "备份中的待同步记录缺失");
    z.number().int().positive().parse(row.generation);
    z.number().int().nonnegative().parse(row.attempts);
    z.number().int().nonnegative().parse(row.next_retry);
    const entity = JSON.parse(local.row(row.entity_id)!.snapshot) as Entity;
    const schema = entity.kind === "task" ? taskBodySchema : projectBodySchema;
    const payload = schema.parse(JSON.parse(row.payload));
    if (row.prepared) {
      const op = JSON.parse(row.prepared) as SyncOperation;
      z.number().int().nonnegative().parse(op.base_version);
      z.enum(["upsert", "delete"]).parse(op.action);
      if (
        op.operation_id !== row.operation_id ||
        op.entity_id !== row.entity_id ||
        op.entity_type !== entity.kind ||
        op.workspace_id !== entity.workspace_id ||
        op.action !== row.action ||
        JSON.stringify(schema.parse(op.payload)) !== JSON.stringify(payload)
      )
        throw new AppError("invalid_backup", "备份中的同步操作不一致");
    }
    if (row.error) {
      z.object({
        code: z.string(),
        message: z.string(),
        remote: z.unknown().nullable(),
      }).parse(JSON.parse(row.error));
    }
  }
  preferencesSchema.parse(local.preferences());
  for (const row of local.db.prepare("SELECT kind,id,json FROM mirror").all()) {
    const data = validateMirror(
      String(row.kind),
      JSON.parse(local.decode(String(row.json))),
    );
    if (data.id !== row.id)
      throw new AppError("invalid_backup", "备份中的协作记录身份不匹配");
  }
  for (const row of local.db.prepare("SELECT id,json FROM reminders").all()) {
    const data = noteResponse.parse(JSON.parse(local.decode(String(row.json))));
    if (data.id !== row.id)
      throw new AppError("invalid_backup", "备份中的提醒记录身份不匹配");
  }
  z.number().int().nonnegative().parse(local.meta("cursor", 0));
  z.boolean().parse(local.meta("syncPaused", false));
  // Pending conflict snapshots may refer to a remotely removed project, so only
  // validate references for records that are not already awaiting user resolution.
  const conflicted = new Set(local.conflicts().map((c) => c.entity_id));
  for (const task of local.entities<Entity<TaskBody>>("task")) {
    if (conflicted.has(task.id)) continue;
    if (
      (task.body.parent_id && !ids.has(task.body.parent_id)) ||
      (task.body.project_id && !ids.has(task.body.project_id))
    )
      throw new AppError("invalid_backup", "备份中的任务关联记录缺失");
  }
}
