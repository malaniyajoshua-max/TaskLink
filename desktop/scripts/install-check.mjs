import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
const phase = process.argv[2];
const expectedVersion = process.argv[4],
  installer = process.argv[5];
if (
  !["baseline", "upgrade"].includes(phase) ||
  !process.argv[3] ||
  !/^\d+\.\d+\.\d+$/.test(expectedVersion ?? "") ||
  (phase === "upgrade" && !installer)
)
  throw new Error(
    "Usage: install-check.mjs baseline|upgrade <validation-directory> <expected-version> [installer]",
  );
const root = path.resolve(".."),
  dir = path.resolve(process.argv[3]),
  python = path.join(root, "server/.venv/Scripts/python.exe");
// The runner may start/terminate only its own installed app and test backend.
// Keep its account, database and process logs below the ignored work directory.
if (
  !dir
    .toLowerCase()
    .startsWith((path.join(root, "work") + path.sep).toLowerCase())
)
  throw new Error(
    "Validation directory must be inside the project's work directory",
  );
mkdirSync(dir, { recursive: true });
const profile = path.join(dir, "profile"),
  reportFile = path.join(dir, "acceptance.json");
const report = existsSync(reportFile)
  ? JSON.parse(readFileSync(reportFile, "utf8"))
  : {};
const serverEnv = {
  ...process.env,
  TASKLINK_DATABASE_URL:
    "sqlite:///" + path.join(dir, "server.db").replaceAll("\\", "/"),
  TASKLINK_ENV: "test",
  TASKLINK_TEST_EMAIL_CODE: "246810",
};
execFileSync(python, ["-m", "app.migrate"], {
  cwd: path.join(root, "server"),
  env: serverEnv,
  windowsHide: true,
  stdio: "ignore",
});
const server = spawn(
  python,
  [
    "-m",
    "uvicorn",
    "app.main:app",
    "--host",
    "127.0.0.1",
    "--port",
    "18767",
    "--no-access-log",
  ],
  {
    cwd: path.join(root, "server"),
    env: serverEnv,
    windowsHide: true,
    stdio: "ignore",
  },
);
let child, browser;
const env = {
  ...process.env,
  TASKLINK_USER_DATA: profile,
  TASKLINK_API_URL: "http://127.0.0.1:18767/api/v1",
  ELECTRON_ENABLE_LOGGING: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.TASKLINK_DEV_URL;
async function startApp() {
  child = spawn(
    path.join(dir, "app/TaskLink.exe"),
    [
      "--remote-debugging-port=18768",
      "--enable-logging=stderr",
      "--no-error-dialogs",
    ],
    {
      env,
      windowsHide: true,
      stdio: [
        "ignore",
        "ignore",
        openSync(path.join(dir, "desktop-startup.log"), "a"),
      ],
    },
  );
  for (let i = 0; i < 15; i++) {
    if (child.exitCode !== null)
      throw new Error(
        "Installed app exited during startup; see desktop-startup.log",
      );
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:18768", {
        timeout: 1000,
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!browser)
    throw new Error("Installed desktop did not expose its validation CDP port");
  await expect
    .poll(() => browser.contexts()[0].pages().length, { timeout: 30000 })
    .toBe(1);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => !!window.tasklink);
  return page;
}
async function stopApp() {
  await browser?.close().catch(() => {});
  browser = undefined;
  if (child?.exitCode === null) {
    const closed = once(child, "exit");
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch("http://127.0.0.1:18767/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (phase === "baseline") {
    const email = "install-validation@example.com";
    const existingLogin = await fetch(
      "http://127.0.0.1:18767/api/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: email,
          password: "TaskLink isolated installation test!2030",
        }),
      },
    );
    if (!existingLogin.ok) {
      const verificationResponse = await fetch(
        "http://127.0.0.1:18767/api/v1/auth/register/code",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        },
      );
      expect(verificationResponse.ok).toBe(true);
      const verification = await verificationResponse.json();
      const registration = await fetch(
        "http://127.0.0.1:18767/api/v1/auth/register",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            name: "安装升级验证",
            password: "TaskLink isolated installation test!2030",
            email_verification_id: verification.request_id,
            email_verification_code: "246810",
          }),
        },
      );
      expect(registration.ok).toBe(true);
    }
  }
  let page = await startApp();
  if (phase === "baseline") {
    const value = await page.evaluate(async () => {
      const api = window.tasklink;
      const user = await api.invoke("auth.login", {
        identifier: "install-validation@example.com",
        password: "TaskLink isolated installation test!2030",
      });
      await api.invoke("sync.pause", { paused: true });
      await api.invoke("settings.set", {
        theme: "dark",
        notifications: false,
        closeToTray: false,
      });
      const task =
        (await api.invoke("tasks.list", {})).find(
          (item) => item.body.title === "升级前未同步任务",
        ) ??
        (await api.invoke("tasks.save", {
          workspace_id: null,
          body: {
            title: "升级前未同步任务",
            description: "升级需要保留正文、待同步操作和界面偏好",
          },
        }));
      return {
        userId: user.id,
        taskId: task.id,
        version: (await api.invoke("updates.status", {})).version,
        pending: (await api.invoke("sync.status", {})).pending,
      };
    });
    expect(value.version).toBe(expectedVersion);
    expect(value.pending).toBe(1);
    report.baseline = value;
    await stopApp();
    expect(existsSync(path.join(profile, "credentials.bin"))).toBe(true);
    expect(existsSync(path.join(profile, "storage-key.bin"))).toBe(true);
  } else {
    await expect(
      page.getByRole("heading", { name: "我的任务", exact: true }),
    ).toBeVisible();
    const value = await page.evaluate(async () => ({
      user: await window.tasklink.invoke("auth.status", {}),
      tasks: await window.tasklink.invoke("tasks.list", {}),
      settings: await window.tasklink.invoke("settings.get", {}),
      sync: await window.tasklink.invoke("sync.status", {}),
      update: await window.tasklink.invoke("updates.status", {}),
      node: typeof window.require,
    }));
    expect(value.user.id).toBe(report.baseline.userId);
    expect(value.tasks[0].id).toBe(report.baseline.taskId);
    expect(value.settings.theme).toBe("dark");
    expect(value.sync.pending).toBe(1);
    expect(value.node).toBe("undefined");
    expect(value.update.version).toBe(expectedVersion);
    await page.evaluate(async () => {
      const api = window.tasklink;
      await api.invoke("sync.pause", { paused: false });
      await api.invoke("sync.run", {});
    });
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.tasklink.invoke("sync.status", {}).then((s) => s.pending),
          ),
        { timeout: 30000 },
      )
      .toBe(0);
    await page.evaluate(async () => {
      const api = window.tasklink,
        task = (await api.invoke("tasks.list", {}))[0];
      await api.invoke("tasks.save", {
        id: task.id,
        workspace_id: null,
        body: { ...task.body, status: "done" },
      });
    });
    await stopApp();
    page = await startApp();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.tasklink
            .invoke("tasks.list", {})
            .then((t) => t[0]?.body.status),
        ),
      )
      .toBe("done");
    const db = new DatabaseSync(
      path.join(profile, "accounts", report.baseline.userId + ".sqlite"),
      { readOnly: true },
    );
    expect(
      db.prepare("SELECT value FROM meta WHERE key='schema'").get().value,
    ).toBe("2");
    expect(
      String(
        db.prepare("SELECT snapshot FROM documents LIMIT 1").get().snapshot,
      ).startsWith("tl2:"),
    ).toBe(true);
    db.close();
    report.upgrade = {
      checkedAt: new Date().toISOString(),
      installerSha256: createHash("sha256")
        .update(readFileSync(path.resolve(installer)))
        .digest("hex"),
      asarSha256: createHash("sha256")
        .update(readFileSync(path.join(dir, "app/resources/app.asar")))
        .digest("hex"),
      version: value.update.version,
      accountPreserved: true,
      outboxPreserved: true,
      themePreserved: true,
      encryptedMigration: true,
      postUpgradeSync: true,
      restartPreserved: true,
    };
    if (process.env.TASKLINK_GALLERY_DIR) {
      mkdirSync(process.env.TASKLINK_GALLERY_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(
          process.env.TASKLINK_GALLERY_DIR,
          "installed-upgrade.png",
        ),
        scale: "css",
      });
    }
  }
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase, passed: true, ...report[phase] }));
} finally {
  await stopApp();
  if (server.exitCode === null) {
    const closed = once(server, "exit");
    server.kill();
    await closed;
  }
}
