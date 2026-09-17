import { randomBytes } from "node:crypto";
const testStorageKey = randomBytes(32);
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { portableBackup, portableRestore } from "../electron/portable-backup";
import { randomUUID } from "node:crypto";
import { ChatStore, validateChatBackup } from "../electron/chat-store";
import { LocalStore } from "../electron/local-store";
import {
  backup,
  exportJson,
  importJson,
  restore,
} from "../electron/data-tools";
import { taskBodySchema, type Task, type Entity } from "../shared/contract";

let store: LocalStore;
let dir: string;
const user = randomUUID();
beforeEach(() => {
  const root = path.resolve("../work/local-tests");
  mkdirSync(root, { recursive: true });
  dir = mkdtempSync(path.join(root, "case-"));
  store = new LocalStore(path.join(dir, "local.sqlite"), user, testStorageKey);
});
afterEach(() => store.close());

function family() {
  const parent = store.save(
    "task",
    taskBodySchema.parse({ title: "交付方案" }),
    null,
  ) as Task;
  const children = ["整理材料", "审阅方案"].map(
    (title, index) =>
      store.save(
        "task",
        taskBodySchema.parse({
          title,
          parent_id: parent.id,
          status: index ? "in_progress" : "todo",
        }),
        null,
      ) as Task,
  );
  return { parent, children };
}
it("links completion both ways and restores the exact family states on undo", () => {
  const { parent, children } = family();
  const result = store.setTaskStatus({ id: parent.id, status: "done" });
  expect(result.changedCount).toBe(3);
  expect(children.map((t) => store.entity<Task>(t.id)!.body.status)).toEqual([
    "done",
    "done",
  ]);
  const child = store.entity<Task>(children[0].id)!;
  store.save(
    "task",
    { ...child.body, description: "需要保留的新说明" },
    null,
    child.id,
  );
  store.undoTaskStatus(result.undoId!);
  expect(store.entity<Task>(parent.id)!.body.status).toBe("todo");
  expect(children.map((t) => store.entity<Task>(t.id)!.body.status)).toEqual([
    "todo",
    "in_progress",
  ]);
  expect(store.entity<Task>(child.id)!.body.description).toBe(
    "需要保留的新说明",
  );
  store.setTaskStatus({ id: children[0].id, status: "done" });
  expect(store.entity<Task>(parent.id)!.body.status).toBe("todo");
  const last = store.setTaskStatus({ id: children[1].id, status: "done" });
  expect(store.entity<Task>(parent.id)!.body.status).toBe("done");
  store.undoTaskStatus(last.undoId!);
  expect(store.entity<Task>(parent.id)!.body.status).toBe("todo");
  expect(store.entity<Task>(children[0].id)!.body.status).toBe("done");
});
it("reopens a completed parent when a child is reopened or added, and cascades an explicit parent reopen", () => {
  const { parent, children } = family();
  store.setTaskStatus({ id: parent.id, status: "done" });
  store.setTaskStatus({ id: children[0].id, status: "todo" });
  expect(store.entity<Task>(parent.id)!.body.status).toBe("in_progress");
  expect(store.entity<Task>(children[1].id)!.body.status).toBe("done");
  store.setTaskStatus({ id: children[0].id, status: "done" });
  store.setTaskStatus({ id: parent.id, status: "in_progress" });
  expect(children.map((t) => store.entity<Task>(t.id)!.body.status)).toEqual([
    "todo",
    "todo",
  ]);
  store.batchTasks({ ids: [parent.id], patch: { status: "done" } });
  store.save(
    "task",
    taskBodySchema.parse({ title: "追加检查", parent_id: parent.id }),
    null,
  );
  expect(store.entity<Task>(parent.id)!.body.status).toBe("in_progress");
});
it("guards undo against changed sibling status or family membership without partial writes", () => {
  const { parent, children } = family();
  const done = store.setTaskStatus({ id: parent.id, status: "done" });
  store.setTaskStatus({ id: children[0].id, status: "todo" });
  const queued = store.queue().length;
  expect(() => store.undoTaskStatus(done.undoId!)).toThrow(/已有更改/);
  expect(store.queue()).toHaveLength(queued);
  const again = store.setTaskStatus({ id: parent.id, status: "done" });
  store.save(
    "task",
    taskBodySchema.parse({
      title: "新增的完成项",
      parent_id: parent.id,
      status: "done",
    }),
    null,
  );
  expect(() => store.undoTaskStatus(again.undoId!)).toThrow(/已有更改/);
});
it("links editor saves and child deletion, but does not complete a parent with no remaining children", () => {
  const { parent, children } = family();
  store.save("task", { ...parent.body, status: "done" }, null, parent.id);
  expect(children.map((t) => store.entity<Task>(t.id)!.body.status)).toEqual([
    "done",
    "done",
  ]);
  store.setTaskStatus({ id: children[0].id, status: "todo" });
  store.remove(children[0].id);
  expect(store.entity<Task>(parent.id)!.body.status).toBe("done");
  store.setTaskStatus({ id: children[1].id, status: "todo" });
  store.remove(children[1].id);
  expect(store.entity<Task>(parent.id)!.body.status).toBe("in_progress");
});

it("changes status without overwriting a newer description and supports conditional undo", () => {
  const task = store.save(
    "task",
    taskBodySchema.parse({ title: "状态修改" }),
    null,
  ) as Task;
  const result = store.setTaskStatus({ id: task.id, status: "done" });
  expect(result.previous).toBe("todo");
  store.save(
    "task",
    { ...result.task.body, description: "另一端的新描述" },
    null,
    task.id,
  );
  const undone = store.setTaskStatus({
    id: task.id,
    status: "todo",
    expectedStatus: "done",
  });
  expect(undone.task.body.description).toBe("另一端的新描述");
  expect(undone.task.body.status).toBe("todo");
});

it("rejects a stale status precondition without writing and does not queue no-op changes", () => {
  const task = store.save(
    "task",
    taskBodySchema.parse({ title: "状态前置条件" }),
    null,
  ) as Task;
  store.setTaskStatus({ id: task.id, status: "in_progress" });
  const queued = store.queue().length;
  expect(() =>
    store.setTaskStatus({
      id: task.id,
      status: "todo",
      expectedStatus: "done",
    }),
  ).toThrow(/状态已有/);
  store.setTaskStatus({ id: task.id, status: "in_progress" });
  expect(store.queue()).toHaveLength(queued);
  expect(store.entity<Task>(task.id)?.body.status).toBe("in_progress");
});

it("atomically applies a batch and preserves every record when one date is invalid", () => {
  const a = store.save(
    "task",
    taskBodySchema.parse({ title: "甲" }),
    null,
  ) as Task;
  const b = store.save(
    "task",
    taskBodySchema.parse({ title: "乙", start_at: "2030-01-02T00:00:00Z" }),
    null,
  ) as Task;
  const before = store.queue().length;
  expect(() =>
    store.batchTasks({
      ids: [a.id, b.id],
      patch: { due_at: "2030-01-01T00:00:00Z" },
    }),
  ).toThrow();
  expect(store.entity<Task>(a.id)?.body.due_at).toBeNull();
  expect(store.queue()).toHaveLength(before);
  const result = store.batchTasks({
    ids: [a.id, b.id, a.id],
    patch: { priority: "urgent", status: "in_progress" },
  });
  expect(result).toHaveLength(2);
  expect(store.entity<Task>(b.id)?.body.status).toBe("in_progress");
});
it("duplicates a parent and its children with fresh IDs, open status and no reminders", () => {
  const a = store.save(
    "task",
    taskBodySchema.parse({
      title: "可复用任务",
      status: "done",
      reminder_at: "2030-01-01T00:00:00Z",
    }),
    null,
  ) as Task;
  store.save(
    "task",
    taskBodySchema.parse({
      title: "检查清单",
      parent_id: a.id,
      status: "done",
      inherit_reminder: true,
    }),
    null,
  );
  const copy = store.duplicateTask(a.id);
  expect(copy.id).not.toBe(a.id);
  expect(copy.body.title).toBe("可复用任务（副本）");
  expect(copy.body.status).toBe("todo");
  expect(copy.body.reminder_at).toBeNull();
  const children = store.children(copy.id);
  expect(children).toHaveLength(1);
  expect(children[0].body.status).toBe("todo");
  expect(children[0].body.inherit_reminder).toBe(false);
  expect(store.entity<Task>(a.id)?.body.status).toBe("done");
});
it("rolls back a batch when a selected record is not a task", () => {
  const a = store.save(
    "task",
    taskBodySchema.parse({ title: "甲" }),
    null,
  ) as Task;
  const project = store.save("project", { name: "项目" }, null);
  expect(() =>
    store.batchTasks({ ids: [a.id, project.id], patch: { status: "done" } }),
  ).toThrow();
  expect(store.entity<Task>(a.id)?.body.status).toBe("todo");
});

it("rejects batch and copy after a workspace becomes read only, with no partial writes", () => {
  const ws = randomUUID();
  store.mirror("workspace", ws, { id: ws, role: "member", deleted: false });
  const personal = store.save("task", body("个人任务"), null);
  const shared = store.save("task", body("团队任务"), ws);
  store.mirror("workspace", ws, { id: ws, role: "viewer", deleted: false });
  const before = store.queue().length;
  expect(() =>
    store.batchTasks({
      ids: [personal.id, shared.id],
      patch: { status: "done" },
    }),
  ).toThrow();
  expect(store.entity<Task>(personal.id)?.body.status).toBe("todo");
  expect(() => store.duplicateTask(shared.id)).toThrow();
  expect(() =>
    store.setTaskStatus({ id: shared.id, status: "done" }),
  ).toThrow();
  expect(store.entities("task")).toHaveLength(2);
  expect(store.queue()).toHaveLength(before);
});

it("recovers 1000 committed writes and immutable outbox entries after process termination", async () => {
  const script = path.join(dir, "crash-writer.cjs"),
    filename = path.join(dir, "crash.sqlite");
  await build({
    entryPoints: ["scripts/crash-writer.ts"],
    outfile: script,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
  });
  const child = spawn(process.execPath, [script, filename, user], {
    env: {
      ...process.env,
      TASKLINK_TEST_KEY: testStorageKey.toString("base64"),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("crash writer timed out")),
        20000,
      );
      child.once("error", reject);
      child.stdout!.on("data", (chunk) => {
        if (String(chunk).includes("committed:1000")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const exited = once(child, "exit");
    child.kill();
    await exited;
    const recovered = new LocalStore(filename, user, testStorageKey);
    try {
      expect(recovered.entities("task")).toHaveLength(1000);
      expect(recovered.pendingCount()).toBe(1000);
      const batch = recovered.prepareBatch(true);
      expect(batch).toHaveLength(100);
      expect(recovered.prepareBatch(true)).toEqual(batch);
      expect(
        recovered.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
      ).toBe("ok");
    } finally {
      recovered.close();
    }
  } finally {
    if (child.exitCode === null) child.kill();
  }
}, 30000);

it("encrypts task content, queued writes, metadata and backups and detects a wrong key", () => {
  const secret = "private-" + randomUUID();
  const task = store.save("task", body(secret), null);
  store.setMeta("private-example", { message: secret });
  store.mirror("notification", randomUUID(), { body: secret });
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(readFileSync(store.filename).includes(Buffer.from(secret))).toBe(
    false,
  );
  const raw = store.db
    .prepare("SELECT snapshot FROM documents WHERE id=?")
    .get(task.id)!.snapshot;
  expect(String(raw).startsWith("tl2:")).toBe(true);
  expect(() => new LocalStore(store.filename, user, randomBytes(32))).toThrow(
    /密钥|损坏/,
  );
  expect(store.entities<Task>("task")[0].body.title).toBe(secret);
});

it("restores a password backup on a different installation and rejects tampering atomically", () => {
  const task = store.save("task", body("Secret across devices"), null);
  const original = store.prepareBatch(true)[0];
  const file = path.join(dir, "portable.tlbackup"),
    password = "a separate long backup phrase";
  portableBackup(store, file, password);
  expect(
    readFileSync(file).includes(Buffer.from("Secret across devices")),
  ).toBe(false);
  const destination = new LocalStore(
    path.join(dir, "new-install.sqlite"),
    user,
    randomBytes(32),
  );
  try {
    expect(() =>
      portableRestore(destination, file, "this password is incorrect"),
    ).toThrow();
    expect(destination.pendingCount()).toBe(0);
    portableRestore(destination, file, password);
    expect(destination.entities<Task>("task")[0].id).toBe(task.id);
    expect(destination.prepareBatch(true)[0]).toEqual(original);
    destination.save("task", body("Keep current work"), null, task.id);
    const damaged = readFileSync(file);
    damaged[100] ^= 1;
    writeFileSync(file, damaged);
    expect(() => portableRestore(destination, file, password)).toThrow();
    expect(destination.entities<Task>("task")[0].body.title).toBe(
      "Keep current work",
    );
  } finally {
    destination.close();
  }
});

it("migrates a legacy plaintext database and removes its old content from live files", () => {
  const secret = "legacy-private-" + randomUUID();
  const task = store.save("task", body(secret), null);
  store.transaction(() => {
    for (const [table, fields] of [
      ["documents", ["snapshot", "server"]],
      ["outbox", ["payload", "prepared", "error"]],
      ["meta", ["value"]],
    ] as const) {
      for (const row of store.db
        .prepare("SELECT rowid AS _rowid,* FROM " + table)
        .all()) {
        if (table === "meta" && ["owner", "schema"].includes(String(row.key)))
          continue;
        for (const field of fields)
          if (row[field] !== null)
            store.db
              .prepare(`UPDATE ${table} SET ${field}=? WHERE rowid=?`)
              .run(store.decode(String(row[field])), row._rowid);
      }
    }
    store.setMeta("schema", 1);
  });
  const filename = store.filename;
  store.close();
  expect(readFileSync(filename).includes(Buffer.from(secret))).toBe(true);
  store = new LocalStore(filename, user, testStorageKey);
  expect(store.entities<Task>("task")[0].id).toBe(task.id);
  expect(store.meta("schema", 0)).toBe(2);
  expect(readFileSync(filename).includes(Buffer.from(secret))).toBe(false);
});
const body = (title = "Task") => taskBodySchema.parse({ title });
function remote(entity: Entity, version = 1): Entity {
  return { ...entity, version };
}

it("writes record and outbox atomically, including rollback on disk-side failure", () => {
  store.db.exec(
    "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'test failure'); END;",
  );
  expect(() => store.save("task", body(), null)).toThrow();
  expect(store.entities("task")).toHaveLength(0);
  expect(store.queue()).toHaveLength(0);
  store.db.exec("DROP TRIGGER fail_outbox");
  store.save("task", body(), null);
  expect(store.queue()).toHaveLength(1);
});
it("recovers unacknowledged edits after restart and freezes operation IDs/payloads", () => {
  const task = store.save("task", body(), null);
  const first = store.prepareBatch()[0];
  store.retry([first]);
  store.save("task", body("Edited while offline"), null, task.id);
  const filename = store.filename;
  store.close();
  store = new LocalStore(filename, user, testStorageKey);
  expect(store.entities<Task>("task")[0].body.title).toBe(
    "Edited while offline",
  );
  expect(store.prepareBatch(true)[0]).toEqual(first);
  store.acknowledge([
    {
      operation_id: first.operation_id,
      status: "applied",
      entity: remote(task),
    },
  ]);
  expect(store.entities<Task>("task")[0].body.title).toBe(
    "Edited while offline",
  );
  const second = store.prepareBatch(true)[0];
  expect(second.base_version).toBe(1);
  expect(second.operation_id).not.toBe(first.operation_id);
});
it("applies pull and cursor in one transaction and retains pending local edits", () => {
  const task = store.save("task", body(), null);
  const first = store.prepareBatch()[0];
  store.acknowledge([
    {
      operation_id: first.operation_id,
      status: "applied",
      entity: remote(task),
    },
  ]);
  store.save("task", body("Local"), null, task.id);
  store.applyChanges(
    [
      {
        sequence: 2,
        entity_id: task.id,
        kind: "task",
        payload: { ...remote(task, 2), body: body("Remote") },
      },
    ],
    2,
  );
  expect(store.entities<Task>("task")[0].body.title).toBe("Local");
  expect(store.meta("cursor", 0)).toBe(2);
  expect(store.prepareBatch(true)[0].base_version).toBe(1);
});
it("preserves revoked offline work as an explainable conflict and can copy it personally", () => {
  const ws = randomUUID();
  store.mirror("workspace", ws, { id: ws, role: "member", deleted: false });
  const task = store.save("task", body("Work to retain"), ws);
  store.applyChanges(
    [
      {
        sequence: 1,
        entity_id: task.id,
        kind: "task",
        payload: { id: task.id, deleted: true, revoked: true },
      },
    ],
    1,
  );
  const conflict = store.conflicts()[0];
  expect(conflict.code).toBe("access_revoked");
  store.resolve(conflict.operation_id, "copy");
  expect(store.entities<Task>("task")[0].workspace_id).toBeNull();
  expect(store.entities<Task>("task")[0].body.title).toBe("Work to retain");
});
it("validates parent dates, prevents cycles and hides deleted children", () => {
  const parent = store.save(
    "task",
    { ...body(), due_at: "2030-01-01T00:00:00Z" },
    null,
  );
  expect(() =>
    store.save(
      "task",
      { ...body(), parent_id: parent.id, due_at: "2031-01-01T00:00:00Z" },
      null,
    ),
  ).toThrow();
  store.save(
    "task",
    { ...body(), parent_id: parent.id, inherit_due: true },
    null,
  );
  store.remove(parent.id);
  expect(store.entities("task")).toHaveLength(0);
});
it("delivers missed reminders once across restarts and marks local notifications read", () => {
  store.save("task", { ...body(), reminder_at: "2020-01-01T00:00:00Z" }, null);
  const notes = store.dueReminders();
  expect(notes).toHaveLength(1);
  expect(store.dueReminders()).toHaveLength(0);
  const filename = store.filename;
  store.close();
  store = new LocalStore(filename, user, testStorageKey);
  expect(store.dueReminders()).toHaveLength(0);
  expect(store.readLocalNote(notes[0].id)?.read).toBe(true);
});
it("does not remind completed families or due-only tasks, and catches up undelivered reminders after reopening", () => {
  const { parent, children } = family();
  store.save(
    "task",
    { ...parent.body, reminder_at: "2020-01-01T00:00:00.000Z" },
    null,
    parent.id,
  );
  for (const child of children)
    store.save(
      "task",
      { ...child.body, inherit_reminder: true },
      null,
      child.id,
    );
  store.save(
    "task",
    taskBodySchema.parse({
      title: "只有截止时间",
      due_at: "2020-01-01T00:00:00.000Z",
    }),
    null,
  );
  const result = store.setTaskStatus({ id: parent.id, status: "done" });
  expect(store.dueReminders()).toHaveLength(0);
  store.undoTaskStatus(result.undoId!);
  const filename = store.filename;
  store.close();
  store = new LocalStore(filename, user, testStorageKey);
  const notes = store.dueReminders();
  expect(notes.map((note) => note.body).sort()).toEqual(
    ["交付方案", "整理材料", "审阅方案"].sort(),
  );
  expect(store.dueReminders()).toHaveLength(0);
});
it("exports/imports real records and restores SQLite with queued operations", () => {
  const task = store.save("task", body("Original"), null);
  const file = path.join(dir, "data.json"),
    db = path.join(dir, "backup.sqlite");
  exportJson(store, file);
  backup(store, db);
  store.save("task", body("Changed"), null, task.id);
  restore(store, db);
  expect(store.entities<Task>("task")[0].body.title).toBe("Original");
  expect(store.pendingCount()).toBe(1);
  expect(importJson(store, file)).toBe(1);
  expect(store.entities("task")).toHaveLength(2);
  expect(store.entities("task")[0].id).not.toBe(store.entities("task")[1].id);
  expect(readFileSync(file, "utf8")).not.toContain("access_token");
  const imported = store.entities<Task>("task").find((t) => t.id !== task.id)!;
  store.save(
    "task",
    { ...imported.body, title: "Immediately edited import" },
    null,
    imported.id,
  );
  const importedOps = store
    .queue()
    .filter((q) => q.entity_id === imported.id)
    .map((q) => JSON.parse(q.prepared!));
  expect(importedOps.map((op) => op.base_version)).toEqual([0, 1]);
});

it("never rolls a pulled newer version back on a late idempotent acknowledgement", () => {
  const task = store.save("task", body("Old"), null);
  const op = store.prepareBatch()[0];
  store.applyChanges(
    [
      {
        sequence: 4,
        kind: "task",
        entity_id: task.id,
        payload: { ...remote(task, 2), body: body("Newer remote") },
      },
    ],
    4,
  );
  store.acknowledge([
    {
      operation_id: op.operation_id,
      status: "applied",
      entity: remote(task, 1),
    },
  ]);
  expect(store.entities<Task>("task")[0].body.title).toBe("Newer remote");
  expect(store.entities<Task>("task")[0].version).toBe(2);
});

it("rejects corrupt backup payloads atomically and retains current work", () => {
  const task = store.save("task", body("Keep me"), null);
  const file = path.join(dir, "corrupt.sqlite");
  backup(store, file);
  const db = new DatabaseSync(file);
  db.prepare("UPDATE outbox SET prepared=?").run(
    JSON.stringify({ operation_id: randomUUID(), base_version: -1 }),
  );
  db.close();
  store.save("task", body("Current work"), null, task.id);
  expect(() => restore(store, file)).toThrow();
  expect(store.entities<Task>("task")[0].body.title).toBe("Current work");
  expect(store.pendingCount()).toBe(2);
});

it("normalizes offset dates and prevents moving a parent into another parent", () => {
  const parent = store.save(
    "task",
    { ...body(), due_at: "2030-01-01T10:00:00+08:00" },
    null,
  );
  expect((parent.body as any).due_at).toBe("2030-01-01T02:00:00.000Z");
  store.save("task", { ...body(), parent_id: parent.id }, null);
  const other = store.save("task", body("Other parent"), null);
  expect(() =>
    store.save("task", { ...body(), parent_id: other.id }, null, parent.id),
  ).toThrow();
});
it("rejects wrong-account backups and invalid imports without partial writes", () => {
  const other = new LocalStore(
    path.join(dir, "other.sqlite"),
    randomUUID(),
    testStorageKey,
  );
  other.save("task", body(), null);
  backup(other, path.join(dir, "other-backup.sqlite"));
  other.close();
  expect(() => restore(store, path.join(dir, "other-backup.sqlite"))).toThrow();
  const file = path.join(dir, "invalid.json");
  writeFileSync(
    file,
    JSON.stringify({
      format: "tasklink-export",
      version: 1,
      documents: [
        { id: randomUUID(), kind: "task", body: body() },
        {
          id: randomUUID(),
          kind: "task",
          body: {
            title: "Bad",
            due_at: "2020-01-01T00:00:00Z",
            reminder_at: "2021-01-01T00:00:00Z",
          },
        },
      ],
    }),
  );
  expect(() => importJson(store, file)).toThrow();
  expect(store.entities("task")).toHaveLength(0);
});

it("encrypts attachment staging and drafts across restart and portable restore, rejecting corrupt backups atomically", () => {
  const peer = randomUUID(),
    secret = "private attachment " + randomUUID();
  const bytes = Buffer.from(secret.repeat(12000)),
    file = path.join(dir, "private-notes.txt");
  writeFileSync(file, bytes);
  let chat = new ChatStore(store);
  const staged = chat.stage([file], peer)[0],
    draft = { id: randomUUID(), body: secret, sticker_id: "received" as const };
  chat.saveDraft(peer, draft);
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(readFileSync(store.filename).includes(Buffer.from(secret))).toBe(
    false,
  );
  const filename = store.filename;
  store.close();
  store = new LocalStore(filename, user, testStorageKey);
  chat = new ChatStore(store);
  expect(chat.draft(peer)).toEqual(draft);
  expect(chat.staged(peer)).toEqual([staged]);
  const snapshot = path.join(dir, "with-attachments.tlbackup"),
    password = "chat backup acceptance phrase";
  portableBackup(store, snapshot, password);
  const target = new LocalStore(
    path.join(dir, "restored.sqlite"),
    user,
    randomBytes(32),
  );
  try {
    portableRestore(target, snapshot, password);
    const restored = new ChatStore(target);
    expect(restored.draft(peer)).toEqual(draft);
    const chunks: Buffer[] = [];
    for (let i = 0; i < Math.ceil(bytes.length / (256 * 1024)); i++)
      chunks.push(restored.chunk(staged.id, i));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    validateChatBackup(target);
    target.db
      .prepare("UPDATE chat_uploads SET peer_id=? WHERE id=?")
      .run(randomUUID(), staged.id);
    expect(() => validateChatBackup(target)).toThrow(/身份/);
  } finally {
    target.close();
  }
  const broken = path.join(dir, "broken-staging.sqlite");
  store.db
    .prepare(
      "DELETE FROM chat_upload_chunks WHERE attachment_id=? AND number=0",
    )
    .run(staged.id);
  backup(store, broken);
  chat.remove(staged.id);
  chat.saveDraft(peer, { ...draft, body: "Keep current draft" });
  expect(() => restore(store, broken)).toThrow(/分块/);
  expect(chat.draft(peer).body).toBe("Keep current draft");
  expect(chat.staged(peer)).toHaveLength(0);
});

it("rejects unsafe files and rolls back an entire multi-file staging operation", () => {
  const chat = new ChatStore(store),
    peer = randomUUID();
  const good = path.join(dir, "allowed.txt"),
    executable = path.join(dir, "program.exe"),
    folder = path.join(dir, "folder.txt");
  writeFileSync(good, "hello");
  writeFileSync(executable, "MZ");
  mkdirSync(folder);
  expect(() => chat.stage([good, executable], peer)).toThrow(/类型/);
  expect(chat.staged()).toHaveLength(0);
  expect(() => chat.stage([folder], peer)).toThrow(/普通文件/);
  expect(() => chat.stage([good, good, good, good, good, good], peer)).toThrow(
    /5/,
  );
  chat.stage([good, good, good, good, good], peer);
  expect(() => chat.stage([good], peer)).toThrow(/5/);
  store.db.exec(
    "CREATE TRIGGER fail_chat BEFORE INSERT ON chat_upload_chunks BEGIN SELECT RAISE(ABORT,'disk failure'); END;",
  );
  const other = randomUUID();
  expect(() => chat.stage([good], other)).toThrow(/disk failure/);
  expect(chat.staged(other)).toHaveLength(0);
});

it("pages a large chat history using an index, preserves equal-time ordering, and restores older mirrors", () => {
  const peer = randomUUID(),
    stamp = new Date().toISOString();
  const ids: string[] = [];
  store.transaction(() => {
    for (let i = 0; i < 10000; i++) {
      const id = randomUUID();
      ids.push(id);
      store.mirror("message", id, {
        id,
        sender_id: user,
        recipient_id: peer,
        created_at: stamp,
        body: "History " + i,
      });
    }
  });
  ids.sort();
  const latest = store.messages(peer, 100);
  expect(latest.map((m) => m.id)).toEqual(ids.slice(-100));
  const earlier = store.messages(peer, 100, {
    id: latest[0].id,
    created_at: stamp,
  });
  expect(earlier.map((m) => m.id)).toEqual(ids.slice(-200, -100));
  expect(store.conversations()[0].last.id).toBe(ids.at(-1));
  const plan = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT json FROM mirror WHERE kind='message' AND peer_id=? ORDER BY created_at DESC,id DESC LIMIT 100",
    )
    .all(peer);
  expect(JSON.stringify(plan)).toContain("mirror_chat_page");
  const oldBackup = path.join(dir, "old-mirror.sqlite");
  backup(store, oldBackup);
  const old = new DatabaseSync(oldBackup);
  try {
    old.exec(
      "DROP INDEX mirror_chat_page; ALTER TABLE mirror DROP COLUMN peer_id; ALTER TABLE mirror DROP COLUMN created_at;",
    );
  } finally {
    old.close();
  }
  restore(store, oldBackup);
  expect(store.messages(peer, 1)[0].id).toBe(ids.at(-1));
});
