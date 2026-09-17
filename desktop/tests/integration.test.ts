import { randomBytes } from "node:crypto";
const testStorageKey = randomBytes(32);
import { beforeAll, afterAll, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { Network } from "../electron/network";
import { ChatStore } from "../electron/chat-store";
import { ChatTransfers } from "../electron/chat-transfers";
import { CHUNK_BYTES } from "../shared/chat";
import { LocalStore } from "../electron/local-store";
import { SyncEngine } from "../electron/sync-engine";
import { taskBodySchema, type Task, type Vault } from "../shared/contract";

const root = path.resolve("..");
const python = path.join(root, "server/.venv/Scripts/python.exe");
mkdirSync(path.join(root, "work/integration"), { recursive: true });
const dir = mkdtempSync(path.join(root, "work/integration/run-"));
const port = 18765,
  base = "http://127.0.0.1:" + port + "/api/v1";
const env = {
  ...process.env,
  TASKLINK_DATABASE_URL:
    "sqlite:///" + path.join(dir, "server.db").replaceAll("\\", "/"),
  TASKLINK_ACCESS_TTL: "1",
  TASKLINK_ENV: "test",
  TASKLINK_TEST_EMAIL_CODE: "246810",
};
const email_verification_code = "246810";
let child: ChildProcess;
async function start() {
  child = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-access-log",
    ],
    { cwd: path.join(root, "server"), env, windowsHide: true, stdio: "ignore" },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://127.0.0.1:" + port + "/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Test API failed to start");
}
async function stop() {
  if (child.exitCode === null) {
    const closed = once(child, "exit");
    child.kill();
    await closed;
  }
}
beforeAll(async () => {
  execFileSync(python, ["-m", "app.migrate"], {
    cwd: path.join(root, "server"),
    env,
    windowsHide: true,
  });
  await start();
});
afterAll(async () => {
  await stop();
});
function network() {
  let saved: Vault = { current: null, revocations: [] };
  const n = new Network(base, saved, async (vault) => {
    saved = vault;
  });
  return n;
}
async function register(
  connection: Network,
  body: {
    email: string;
    name: string;
    password: string;
  },
) {
  const verification = await connection.requestRegistrationCode({
    email: body.email,
  });
  return connection.login("register", {
    ...body,
    email_verification_id: verification.request_id,
    email_verification_code,
  });
}
it("a delayed offline-logout revocation cannot overwrite a new login", async () => {
  let saved: Vault = { current: null, revocations: [] };
  let release: (() => void) | undefined;
  let hold = false;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const n = new Network(base, saved, async (vault) => {
    if (hold && vault.current === null && vault.revocations.length === 0) {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    saved = vault;
  });
  const password = "isolated concurrency validation!2030";
  await register(n, {
    email: randomUUID() + "@example.com",
    name: "Old account",
    password,
  });
  hold = true;
  await n.logout();
  await waiting;
  const nextLogin = register(n, {
    email: randomUUID() + "@example.com",
    name: "New account",
    password,
  });
  release!();
  const next = await nextLogin;
  expect(saved.current?.user.id).toBe(next.id);
  expect(n.vault.current?.user.id).toBe(next.id);
  expect(saved.revocations).toHaveLength(0);
});
it("pauses an in-flight real batch before sending subsequent work and resumes without loss", async () => {
  const connection = network();
  const user = await register(connection, {
    name: "Pause QA",
    email: "pause-" + randomUUID() + "@example.com",
    password: "correct horse battery",
  });
  const local = new LocalStore(
    path.join(dir, "pause.sqlite"),
    user.id,
    randomBytes(32),
  );
  const engine = new SyncEngine(local, connection, () => {});
  const original = connection.request.bind(connection);
  let pushes = 0;
  connection.request = async (...args: Parameters<Network["request"]>) => {
    const response = await original(...args);
    if (args[0] === "/sync/push" && ++pushes === 1) engine.paused = true;
    return response as any;
  };
  try {
    for (let i = 0; i < 250; i++)
      local.save(
        "task",
        taskBodySchema.parse({ title: "pause acceptance " + i }),
        null,
      );
    await engine.run(true);
    expect(pushes).toBe(1);
    expect(local.pendingCount()).toBe(150);
    expect(engine.status().lastSynced).toBeNull();
    engine.paused = false;
    await engine.run(true);
    expect(local.pendingCount()).toBe(0);
    expect(local.entities("task")).toHaveLength(250);
  } finally {
    await engine.stop();
    local.close();
  }
});
it("synchronizes linked family completion, undo and reopening between two devices", async () => {
  const a = network(),
    b = network();
  const email = `family-${randomUUID()}@example.com`,
    password = "correct horse battery";
  const user = await register(a, { name: "Family QA", email, password });
  await b.login("login", { identifier: email, password });
  const sa = new LocalStore(
    path.join(dir, "family-a.sqlite"),
    user.id,
    testStorageKey,
  );
  const sb = new LocalStore(
    path.join(dir, "family-b.sqlite"),
    user.id,
    testStorageKey,
  );
  const ea = new SyncEngine(sa, a, () => {}),
    eb = new SyncEngine(sb, b, () => {});
  try {
    const parent = sa.save(
      "task",
      taskBodySchema.parse({ title: "共同交付" }),
      null,
    ) as Task;
    const children = ["设计", "验收"].map(
      (title, i) =>
        sa.save(
          "task",
          taskBodySchema.parse({
            title,
            parent_id: parent.id,
            status: i ? "in_progress" : "todo",
          }),
          null,
        ) as Task,
    );
    await ea.run(true);
    await eb.run(true);
    const done = sa.setTaskStatus({ id: parent.id, status: "done" });
    await ea.run(true);
    await eb.run(true);
    expect(sb.entities<Task>("task").map((t) => t.body.status)).toEqual([
      "done",
      "done",
      "done",
    ]);
    sa.undoTaskStatus(done.undoId!);
    await ea.run(true);
    await eb.run(true);
    expect(sb.entity<Task>(parent.id)!.body.status).toBe("todo");
    expect(sb.entity<Task>(children[1].id)!.body.status).toBe("in_progress");
    sb.batchTasks({
      ids: children.map((t) => t.id),
      patch: { status: "done" },
    });
    await eb.run(true);
    await ea.run(true);
    expect(sa.entity<Task>(parent.id)!.body.status).toBe("done");
    sb.setTaskStatus({ id: children[0].id, status: "todo" });
    await eb.run(true);
    await ea.run(true);
    expect(sa.entity<Task>(parent.id)!.body.status).toBe("in_progress");
    expect(sa.entity<Task>(children[1].id)!.body.status).toBe("done");
    expect(sa.pendingCount() + sb.pendingCount()).toBe(0);
    expect(sa.conflicts().length + sb.conflicts().length).toBe(0);
  } finally {
    await ea.stop();
    await eb.stop();
    sa.close();
    sb.close();
  }
});
it("two real SQLite devices converge after service outage, retry, conflict and refresh", async () => {
  const a = network(),
    b = network(),
    email = "sync-" + randomUUID() + "@example.com",
    password = "correct horse battery";
  const user = await register(a, {
    name: "Sync QA",
    email,
    password,
  });
  await b.login("login", { identifier: email, password });
  let sa = new LocalStore(path.join(dir, "a.sqlite"), user.id, testStorageKey),
    sb = new LocalStore(path.join(dir, "b.sqlite"), user.id, testStorageKey);
  let ea = new SyncEngine(sa, a, () => {}),
    eb = new SyncEngine(sb, b, () => {});
  try {
    const task = sa.save(
      "task",
      taskBodySchema.parse({ title: "Initial" }),
      null,
    ) as Task;
    await ea.run(true);
    await eb.run(true);
    expect(sb.entities<Task>("task")[0].body.title).toBe("Initial");
    // Stop the real service; neither device can contact it.
    await ea.stop();
    await eb.stop();
    await stop();
    sa.save("task", { ...task.body, title: "Written offline" }, null, task.id);
    ea = new SyncEngine(sa, a, () => {});
    expect((await ea.run(true)).state).toBe("offline");
    expect(sa.meta("nextSyncAttempt", 0)).toBeGreaterThan(Date.now());
    await ea.stop();
    sa.close();
    sa = new LocalStore(path.join(dir, "a.sqlite"), user.id, testStorageKey);
    expect(sa.entities<Task>("task")[0].body.title).toBe("Written offline");
    await start();
    ea = new SyncEngine(sa, a, () => {});
    eb = new SyncEngine(sb, b, () => {});
    await ea.run(true);
    await eb.run(true);
    expect(sb.entities<Task>("task")[0].body.title).toBe("Written offline");
    const current = sa.entities<Task>("task")[0],
      other = sb.entities<Task>("task")[0];
    sa.save(
      "task",
      { ...current.body, title: "Device A change" },
      null,
      current.id,
    );
    sb.save(
      "task",
      { ...other.body, title: "Device B change" },
      null,
      other.id,
    );
    // B has only edited locally; even a pull before its first send must not
    // silently upgrade the version on which that edit was based.
    await ea.run(true);
    await eb.run(true);
    expect(sb.conflicts()).toHaveLength(1);
    sb.resolve(sb.conflicts()[0].operation_id, "local");
    await eb.run(true);
    await ea.run(true);
    expect(sa.entities<Task>("task")[0].body.title).toBe("Device B change");
    // Lost HTTP acknowledgement: submit without acknowledging in local SQLite, then replay.
    sa.save(
      "task",
      { ...sa.entities<Task>("task")[0].body, title: "Response lost" },
      null,
      task.id,
    );
    const operations = sa.prepareBatch(true);
    await a.request("/sync/push", "POST", { operations });
    await ea.run(true);
    expect(sa.pendingCount()).toBe(0);
    const token = a.vault.current!.access_token;
    await new Promise((r) => setTimeout(r, 1200));
    await a.request("/tasks");
    expect(a.vault.current!.access_token).not.toBe(token);
    sa.remove(task.id);
    await ea.run(true);
    await eb.run(true);
    expect(sb.entities("task")).toHaveLength(0);
    await a.logout();
    expect(a.vault.current).toBeNull();
  } finally {
    await ea.stop();
    await eb.stop();
    sa.close();
    sb.close();
  }
});

it("resumes a cancelled real multi-chunk transfer after restart, refreshes tokens, verifies downloads and enforces participant permission", async () => {
  const a = network(),
    b = network(),
    outsider = network();
  const password = "secure chat integration acceptance";
  const alice = await register(a, {
    email: randomUUID() + "@example.com",
    name: "Sender",
    password,
  });
  const bob = await register(b, {
    email: randomUUID() + "@example.com",
    name: "Recipient",
    password,
  });
  await register(outsider, {
    email: randomUUID() + "@example.com",
    name: "Outsider",
    password,
  });
  const friend = await a.request<{ id: string }>("/friends", "POST", {
    email: bob.email,
  });
  await b.request("/friends/" + friend.id + "/decision", "POST", {
    accept: true,
  });
  let local = new LocalStore(
    path.join(dir, "chat-a.sqlite"),
    alice.id,
    testStorageKey,
  );
  const other = new LocalStore(
    path.join(dir, "chat-b.sqlite"),
    bob.id,
    testStorageKey,
  );
  let chat = new ChatStore(local),
    connected = true,
    cut = true;
  let transfers: ChatTransfers;
  transfers = new ChatTransfers(
    chat,
    a,
    (value) => {
      if (cut && value.completed >= CHUNK_BYTES) {
        cut = false;
        transfers.cancel(value.id);
      }
    },
    () => {},
    () => connected,
  );
  const bytes = Buffer.from("Confidential transfer roundtrip. ".repeat(19000));
  const file = path.join(dir, "roundtrip.txt");
  writeFileSync(file, bytes);
  const [attachment] = chat.stage([file], bob.id),
    draft = {
      id: randomUUID(),
      body: "请查收附件",
      sticker_id: "received" as const,
    };
  const input = {
    ...draft,
    recipient_id: bob.id,
    attachment_ids: [attachment.id],
  };
  chat.saveDraft(bob.id, draft);
  try {
    await expect(transfers.send(input)).rejects.toThrow(/取消/);
    const begun = await a.request<{ uploaded_chunks: number[] }>(
      "/attachments",
      "POST",
      {
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        sha256: attachment.sha256,
        recipient_id: bob.id,
      },
    );
    expect(begun.uploaded_chunks).toEqual([0]);
    await expect(b.request("/attachments/" + attachment.id)).rejects.toThrow(
      /权限/,
    );
    local.close();
    local = new LocalStore(
      path.join(dir, "chat-a.sqlite"),
      alice.id,
      testStorageKey,
    );
    chat = new ChatStore(local);
    transfers = new ChatTransfers(
      chat,
      a,
      () => {},
      () => {},
      () => connected,
    );
    expect(chat.draft(bob.id)).toEqual(draft);
    connected = false;
    await expect(transfers.send(input)).rejects.toThrow(/连接/);
    expect(chat.staged(bob.id)).toHaveLength(1);
    connected = true;
    const oldToken = a.vault.current!.refresh_token;
    a.vault.current!.expiresAt = 0;
    const sent = await transfers.send(input);
    expect(a.vault.current!.refresh_token).not.toBe(oldToken);
    expect(sent.attachments?.[0].sha256).toBe(attachment.sha256);
    expect(chat.staged(bob.id)).toHaveLength(0);
    expect(chat.draft(bob.id).body).toBe("");
    expect((await transfers.send(input)).id).toBe(sent.id);
    await expect(
      transfers.send({ ...input, body: "ID reused with different text" }),
    ).rejects.toThrow(/标识/);
    const sync = new SyncEngine(other, b, () => {});
    try {
      await sync.run(true);
      expect(
        other.allMirror<{ id: string }>("message").map((m) => m.id),
      ).toContain(sent.id);
    } finally {
      await sync.stop();
    }
    const received = new ChatTransfers(
      new ChatStore(other),
      b,
      () => {},
      () => {},
      () => true,
    );
    const destination = path.join(dir, "download.txt");
    await received.save(attachment.id, destination);
    expect(readFileSync(destination)).toEqual(bytes);
    if (process.platform === "win32")
      expect(readFileSync(destination + ":Zone.Identifier", "utf8")).toContain(
        "ZoneId=3",
      );
    await expect(
      outsider.request(
        "/attachments/" + attachment.id + "/chunks/0",
        "GET",
        undefined,
        { binary: true },
      ),
    ).rejects.toThrow(/权限/);
    await a.request("/friends/" + friend.id, "DELETE");
    await expect(received.info(attachment.id)).rejects.toThrow(/好友/);
  } finally {
    local.close();
    other.close();
  }
}, 30000);

it("keeps real worker task writes responsive during a stalled upload and drains transfers before logout", async () => {
  const a = network(),
    b = network(),
    password = "media worker responsiveness test";
  const alice = await register(a, {
    email: randomUUID() + "@example.com",
    name: "Worker sender",
    password,
  });
  const bob = await register(b, {
    email: randomUUID() + "@example.com",
    name: "Worker recipient",
    password,
  });
  const friend = await a.request<{ id: string }>("/friends", "POST", {
    email: bob.email,
  });
  await b.request("/friends/" + friend.id + "/decision", "POST", {
    accept: true,
  });
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
      release = resolve;
    }),
    waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const proxy = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.method === "PUT" && request.url?.includes("/chunks/0")) {
        entered();
        await hold;
      }
      if (response.destroyed) return;
      const remote = await fetch("http://127.0.0.1:" + port + request.url, {
        method: request.method,
        headers: {
          "Content-Type": String(
            request.headers["content-type"] ?? "application/json",
          ),
          ...(request.headers.authorization
            ? { Authorization: request.headers.authorization }
            : {}),
        },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      response.writeHead(remote.status, {
        "Content-Type":
          remote.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(await remote.arrayBuffer()));
    } catch {
      if (!response.destroyed) {
        response.writeHead(502);
        response.end();
      }
    }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyPort = (proxy.address() as { port: number }).port;
  const file = path.join(dir, "stalled-transfer.txt");
  writeFileSync(file, "worker remains responsive ".repeat(23000));
  const bundle = path.join(dir, "chat-worker.cjs");
  await build({
    entryPoints: ["electron/worker.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
  });
  const worker = new Worker(bundle, {
    workerData: {
      directory: path.join(dir, "worker-profile"),
      api: `http://127.0.0.1:${proxyPort}/api/v1`,
      vault: a.vault,
      storageKey: randomBytes(32),
    },
  });
  const pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  worker.on("message", (message) => {
    if (message.type === "ready") ready();
    if (message.type === "vault")
      worker.postMessage({ type: "vault-result", id: message.id, ok: true });
    if (message.type !== "result") return;
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    clearTimeout(operation.timer);
    if (message.result.ok) operation.resolve(message.result.value);
    else operation.reject(new Error(message.result.error.message));
  });
  const rpc = (command: string, input: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = randomUUID(),
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Worker request stalled: " + command));
        }, 5000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: "request", id, command, input });
    });
  try {
    await started;
    await rpc("sync.run");
    for (let i = 0; i < 30 && !(await rpc("friends.list")).length; i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const [fileInfo] = await rpc("file.chat-stage", {
      paths: [file],
      peer_id: bob.id,
    });
    const send = rpc("messages.send", {
      id: randomUUID(),
      recipient_id: bob.id,
      body: "held in real proxy",
      attachment_ids: [fileInfo.id],
    }).then(
      () => "sent",
      (error) => error.message,
    );
    await waiting;
    expect(await rpc("chat.activity", { peer_id: bob.id })).toEqual({
      sending: true,
    });
    await expect(
      rpc("attachments.remove", { id: fileInfo.id }),
    ).rejects.toThrow(/取消/);
    const start = performance.now();
    const task = await rpc("tasks.save", {
      workspace_id: null,
      body: { title: "Editable during file upload" },
    });
    expect(performance.now() - start).toBeLessThan(1500);
    expect((await rpc("tasks.list"))[0].id).toBe(task.id);
    const logoutStart = performance.now();
    await rpc("auth.logout");
    expect(performance.now() - logoutStart).toBeLessThan(3000);
    expect(await send).toMatch(/取消/);
    expect(await rpc("auth.status")).toBeNull();
    await expect(rpc("tasks.list")).rejects.toThrow(/登录/);
  } finally {
    release();
    await worker.terminate();
    for (const operation of pending.values()) clearTimeout(operation.timer);
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}, 30000);
