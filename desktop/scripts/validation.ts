/** Reproducible, non-mocked capacity/endurance validation. Only isolated test data. */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { strict as assert } from "node:assert";
import { LocalStore } from "../electron/local-store";
import { Network } from "../electron/network";
import { SyncEngine } from "../electron/sync-engine";
import { taskBodySchema, type Task } from "../shared/contract";

const mode = process.argv[2] ?? "scale";
const root = path.resolve(".."),
  python = path.join(root, "server/.venv/Scripts/python.exe");
const output = path.join(root, "work/validation");
mkdirSync(output, { recursive: true });
const dir = mkdtempSync(path.join(output, mode + "-"));
const port = Number(
  process.env.TASKLINK_VALIDATION_PORT ?? (mode === "scale" ? 18769 : 18770),
);
const env = {
  ...process.env,
  TASKLINK_DATABASE_URL:
    "sqlite:///" + path.join(dir, "server.db").replaceAll("\\", "/"),
  TASKLINK_ACCESS_TTL: mode === "scale" ? "900" : "5",
  TASKLINK_ENV: "test",
  TASKLINK_TEST_EMAIL_CODE: "246810",
};
const keyA = randomBytes(32),
  keyB = randomBytes(32);
const started = Date.now();
const codeHash = createHash("sha256");
for (const file of ["local-store", "storage-crypto", "network", "sync-engine"])
  codeHash.update(
    readFileSync(path.join(root, "desktop/electron/" + file + ".ts")),
  );
const report: Record<string, any> = {
  mode,
  started: new Date().toISOString(),
  directory: dir,
  coreSha256: codeHash.digest("hex"),
  errors: [],
  samples: [],
};
function record(event: string, details: Record<string, unknown> = {}) {
  report.lastEvent = event;
  report.elapsedSeconds = Math.round((Date.now() - started) / 1000);
  Object.assign(report, details);
  writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      event,
      elapsedSeconds: report.elapsedSeconds,
      ...details,
    }),
  );
}
let server: ChildProcess | undefined;
let a: LocalStore | undefined,
  b: LocalStore | undefined,
  ea: SyncEngine | undefined,
  eb: SyncEngine | undefined;
const na = new Network(
  `http://127.0.0.1:${port}/api/v1`,
  { current: null, revocations: [] },
  async () => {},
);
const nb = new Network(
  na.base,
  { current: null, revocations: [] },
  async () => {},
);
async function start() {
  server = spawn(
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
      "--limit-concurrency",
      "64",
    ],
    { cwd: path.join(root, "server"), env, windowsHide: true, stdio: "ignore" },
  );
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("validation server did not start");
}
async function stop() {
  if (server && server.exitCode === null) {
    const closed = once(server, "exit");
    server.kill();
    await closed;
  }
}
function engines() {
  ea = new SyncEngine(a!, na, () => {});
  eb = new SyncEngine(b!, nb, () => {});
}
async function sync(engine: SyncEngine) {
  // A timer may already have captured its batch before the caller wrote new data.
  // Await it, then explicitly run another pass so assertions observe convergence.
  await engine.run(true);
  const result = await engine.run(true);
  assert.equal(result.state, "idle", "sync status: " + result.error);
}
function stats(samples: number[]) {
  const values = [...samples].sort((a, b) => a - b);
  return {
    p50: values[Math.floor(values.length * 0.5)],
    p95: values[Math.floor(values.length * 0.95)],
    p99: values[Math.floor(values.length * 0.99)],
    max: values.at(-1),
  };
}
try {
  execFileSync(python, ["-m", "app.migrate"], {
    cwd: path.join(root, "server"),
    env,
    windowsHide: true,
    stdio: "ignore",
  });
  await start();
  const email = `${mode}-${randomUUID()}@example.com`,
    password = "TaskLink isolated validation only!2030";
  const verification = await na.requestRegistrationCode({ email });
  const user = await na.login("register", {
    email,
    password,
    name: "隔离验证账号",
    email_verification_id: verification.request_id,
    email_verification_code: "246810",
  });
  await nb.login("login", { identifier: email, password });
  a = new LocalStore(path.join(dir, "device-a.sqlite"), user.id, keyA);
  b = new LocalStore(path.join(dir, "device-b.sqlite"), user.id, keyB);
  engines();
  record("started", { userId: user.id, email });
  if (mode === "scale") {
    const count = Number(process.env.TASKLINK_SCALE_COUNT ?? 100000),
      timings: number[] = [];
    const createStart = performance.now();
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      a.save(
        "task",
        taskBodySchema.parse({
          title: `容量验证任务 ${String(i).padStart(6, "0")}`,
          description: "仅供本机容量验证，无真实用户信息。".repeat(5),
          status: i % 5 === 0 ? "done" : "todo",
          due_at: i % 3 === 0 ? "2030-01-01T10:00:00.000Z" : null,
        }),
        null,
      );
      if (i % 50 === 0) timings.push(performance.now() - start);
      if ((i + 1) % 10000 === 0) {
        record("local-create", { created: i + 1 });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    report.createMilliseconds = performance.now() - createStart;
    report.localWriteMilliseconds = stats(timings);
    let point = performance.now();
    assert.equal(a.entities("task").length, count);
    report.readAllMilliseconds = performance.now() - point;
    point = performance.now();
    for (let i = 0; i < 20; i++) a.dueReminders();
    report.reminderScanMilliseconds = (performance.now() - point) / 20;
    point = performance.now();
    for (let i = 0; i < 20; i++) ea!.status();
    report.queueStatusMilliseconds = (performance.now() - point) / 20;
    await ea!.stop();
    a.close();
    point = performance.now();
    a = new LocalStore(path.join(dir, "device-a.sqlite"), user.id, keyA);
    report.restartMilliseconds = performance.now() - point;
    engines();
    record("local-capacity-complete", {
      count,
      databaseBytes: statSync(a.filename).size,
      localWriteMilliseconds: report.localWriteMilliseconds,
      readAllMilliseconds: report.readAllMilliseconds,
      reminderScanMilliseconds: report.reminderScanMilliseconds,
    });
    point = performance.now();
    while (a.pendingCount()) {
      await sync(ea!);
      record("server-ingest", { remaining: a.pendingCount() });
    }
    report.serverIngestMilliseconds = performance.now() - point;
    point = performance.now();
    await sync(eb!);
    report.secondDevicePullMilliseconds = performance.now() - point;
    assert.equal(b.entities("task").length, count);
    assert.equal(b.pendingCount(), 0);
    const entity = a.entities<Task>("task")[count - 1];
    point = performance.now();
    a.save(
      "task",
      { ...entity.body, title: "十万条中的编辑验证", status: "done" },
      null,
      entity.id,
    );
    await sync(ea!);
    await sync(eb!);
    report.editAndConvergeMilliseconds = performance.now() - point;
    assert.equal(b.entity<Task>(entity.id)!.body.title, "十万条中的编辑验证");
    record("scale-complete", {
      passed: true,
      count,
      serverIngestMilliseconds: report.serverIngestMilliseconds,
      secondDevicePullMilliseconds: report.secondDevicePullMilliseconds,
      editAndConvergeMilliseconds: report.editAndConvergeMilliseconds,
    });
  } else {
    const duration = Number(process.env.TASKLINK_SOAK_SECONDS ?? 3600) * 1000;
    let cycles = 0,
      operations = 0,
      outages = 0,
      restarts = 0,
      conflicts = 0;
    const stable = a.save(
      "task",
      taskBodySchema.parse({ title: "持续运行共同任务" }),
      null,
    ) as Task;
    await sync(ea!);
    await sync(eb!);
    const baseline = Date.now();
    while (Date.now() - baseline < duration) {
      cycles++;
      if (cycles % 8 === 0) {
        await stop();
        outages++;
      }
      for (let i = 0; i < 25; i++) {
        a.save(
          "task",
          taskBodySchema.parse({
            title: `循环 ${cycles} / ${i}`,
            status: i % 4 === 0 ? "done" : "todo",
          }),
          null,
        );
        operations++;
      }
      if (cycles % 8 === 0) {
        await ea!.run(true);
        const offline = await ea!.run(true);
        assert.equal(offline.state, "offline");
        assert.ok(a.pendingCount() >= 25);
        await start();
      }
      await sync(ea!);
      await sync(eb!);
      if (cycles % 5 === 0) {
        const left = a.entity<Task>(stable.id)!,
          right = b.entity<Task>(stable.id)!;
        a.save(
          "task",
          { ...left.body, title: `设备 A 修改 ${cycles}` },
          null,
          left.id,
        );
        b.save(
          "task",
          { ...right.body, title: `设备 B 修改 ${cycles}` },
          null,
          right.id,
        );
        await sync(ea!);
        await sync(eb!);
        const conflict = b.conflicts()[0];
        assert.ok(conflict);
        b.resolve(conflict.operation_id, "local");
        conflicts++;
        await sync(eb!);
        await sync(ea!);
        operations += 3;
      }
      if (cycles % 12 === 0) {
        await ea!.stop();
        await eb!.stop();
        a.close();
        b.close();
        a = new LocalStore(path.join(dir, "device-a.sqlite"), user.id, keyA);
        b = new LocalStore(path.join(dir, "device-b.sqlite"), user.id, keyB);
        engines();
        restarts++;
        await sync(ea!);
        await sync(eb!);
      }
      assert.equal(a.pendingCount(), 0);
      assert.equal(b.pendingCount(), 0);
      const left = a.entities<Task>("task"),
        right = b.entities<Task>("task");
      assert.equal(left.length, right.length);
      assert.equal(
        a.entity<Task>(stable.id)!.body.title,
        b.entity<Task>(stable.id)!.body.title,
      );
      report.samples.push({
        seconds: Math.round((Date.now() - baseline) / 1000),
        rss: process.memoryUsage().rss,
        heap: process.memoryUsage().heapUsed,
        records: left.length,
      });
      record("soak-cycle", {
        cycles,
        operations,
        outages,
        restarts,
        conflicts,
        records: left.length,
      });
      await new Promise((r) =>
        setTimeout(
          r,
          Math.min(15000, Math.max(0, duration - (Date.now() - baseline))),
        ),
      );
    }
    record("soak-complete", {
      passed: true,
      observedSeconds: Math.round((Date.now() - baseline) / 1000),
      cycles,
      operations,
      outages,
      restarts,
      conflicts,
    });
  }
} catch (error) {
  report.errors.push(
    error instanceof Error ? error.message : "validation failed",
  );
  record("failed", { passed: false });
  process.exitCode = 1;
} finally {
  await ea?.stop();
  await eb?.stop();
  a?.close();
  b?.close();
  await stop();
  record("finished", { finished: new Date().toISOString() });
}
