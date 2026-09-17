/** Production Electron fuses disable the Node inspector; validate via renderer CDP. */
import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getCurrentFuseWire } from "@electron/fuses";
const root = path.resolve(".."),
  executable = path.resolve(
    process.argv[2] ?? "release/win-unpacked/TaskLink.exe",
  );
mkdirSync(path.join(root, "work/packaged-check"), { recursive: true });
const dir = mkdtempSync(path.join(root, "work/packaged-check/run-"));
const python = path.join(root, "server/.venv/Scripts/python.exe");
const serverEnv = {
  ...process.env,
  TASKLINK_DATABASE_URL:
    "sqlite:///" + path.join(dir, "server.db").replaceAll("\\", "/"),
  TASKLINK_ACCESS_TTL: "2",
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
    "18776",
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
  TASKLINK_USER_DATA: path.join(dir, "profile"),
  TASKLINK_API_URL: "http://127.0.0.1:18776/api/v1",
};
delete env.ELECTRON_RUN_AS_NODE;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function start() {
  child = spawn(executable, ["--remote-debugging-port=18777"], {
    env,
    windowsHide: true,
    stdio: "ignore",
  });
  for (let i = 0; i < 30; i++) {
    if (child.exitCode !== null)
      throw new Error("Packaged application exited before validation");
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:18777", {
        timeout: 1000,
      });
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!browser) throw new Error("Packaged window did not start");
  await expect
    .poll(() => browser.contexts()[0].pages().length, { timeout: 30000 })
    .toBe(1);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => !!window.tasklink);
  return page;
}
async function stop() {
  await browser?.close().catch(() => {});
  browser = undefined;
  if (child?.exitCode === null) {
    const done = once(child, "exit");
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await done;
    await sleep(1000);
  }
}
const report = {
  executable,
  executableSha256: createHash("sha256")
    .update(readFileSync(executable))
    .digest("hex"),
  asarSha256: createHash("sha256")
    .update(
      readFileSync(path.join(path.dirname(executable), "resources/app.asar")),
    )
    .digest("hex"),
  directory: dir,
  started: new Date().toISOString(),
  passed: false,
};
try {
  for (let i = 0; i < 100; i++) {
    try {
      if (
        (
          await fetch("http://127.0.0.1:18776/health", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        break;
    } catch {}
    if (i === 99) throw new Error("API startup failed");
    await sleep(100);
  }
  const fuses = await getCurrentFuseWire(executable);
  for (const id of [0, 2, 3, 7]) expect(fuses[id]).toBe(48);
  for (const id of [4, 5]) expect(fuses[id]).toBe(49);
  report.fuses = fuses;
  let page = await start();
  await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await page.getByLabel("昵称", { exact: true }).fill("发行包验收");
  await page
    .getByLabel("绑定邮箱", { exact: true })
    .fill("packaged@example.com");
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  await expect(page.getByRole("button", { name: /秒后重发/ })).toBeVisible();
  await page.getByLabel("邮箱验证码", { exact: true }).fill("246810");
  await page
    .getByLabel("密码", { exact: true })
    .fill("TaskLink isolated packaged validation!2030");
  await page
    .getByLabel("确认密码", { exact: true })
    .fill("TaskLink isolated packaged validation!2030");
  await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "账号创建成功", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "开始使用", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "我的任务", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  const value = await page.evaluate(async () => {
    const api = window.tasklink;
    await api.invoke("sync.pause", { paused: true });
    const task = await api.invoke("tasks.save", {
      workspace_id: null,
      body: { title: "正式构建崩溃恢复验证" },
    });
    return {
      id: task.id,
      version: (await api.invoke("updates.status", {})).version,
      node: typeof window.require,
    };
  });
  expect(value.node).toBe("undefined");
  expect(value.version).toBe(
    JSON.parse(readFileSync("package.json", "utf8")).version,
  );
  await stop();
  page = await start();
  const restored = await page.evaluate(async () => ({
    tasks: await window.tasklink.invoke("tasks.list", {}),
    sync: await window.tasklink.invoke("sync.status", {}),
  }));
  expect(restored.tasks[0].id).toBe(value.id);
  expect(restored.sync.pending).toBe(1);
  expect(restored.sync.paused).toBe(true);
  await page.evaluate(() =>
    window.tasklink.invoke("sync.pause", { paused: false }),
  );
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.tasklink
            .invoke("sync.status", {})
            .then((s) => ({ pending: s.pending, state: s.state })),
        ),
      { timeout: 30000 },
    )
    .toEqual({ pending: 0, state: "idle" });
  expect(
    readFileSync(path.join(dir, "profile/credentials.bin"))
      .subarray(0, 5)
      .toString(),
  ).toBe("TLDP1");
  const family = await page.evaluate(async () => {
    const api = window.tasklink;
    const parent = await api.invoke("tasks.save", {
      workspace_id: null,
      body: { title: "发行包父子任务验证" },
    });
    const children = [];
    for (const status of ["todo", "in_progress"])
      children.push(
        await api.invoke("tasks.save", {
          workspace_id: null,
          body: {
            title: "交付步骤",
            parent_id: parent.id,
            status,
          },
        }),
      );
    const ids = [parent.id, ...children.map((item) => item.id)];
    const states = async () => {
      const tasks = await api.invoke("tasks.list", {});
      return ids.map((id) => tasks.find((item) => item.id === id).body.status);
    };
    const completed = await api.invoke("tasks.status", {
      id: parent.id,
      status: "done",
    });
    const done = await states();
    await api.invoke("tasks.undoStatus", { id: completed.undoId });
    return { done, restored: await states() };
  });
  expect(family.done).toEqual(["done", "done", "done"]);
  expect(family.restored).toEqual(["todo", "todo", "in_progress"]);
  report.familyStatusLinked = true;
  const themeIds = [
    "spring-day",
    "spring-night",
    "summer-day",
    "summer-night",
    "autumn-day",
    "autumn-night",
    "winter-day",
    "winter-night",
  ];
  for (const theme of themeIds) {
    await page.evaluate(
      (theme) => window.tasklink.invoke("settings.patch", { theme }),
      theme,
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-appearance",
      theme,
    );
  }
  await stop();
  page = await start();
  await expect(page.locator("html")).toHaveAttribute(
    "data-appearance",
    "winter-night",
  );
  report.seasonalThemes = { count: themeIds.length, restartPreserved: true };
  // Exercise the actual fused package's second window and native File bridge.
  const apiBase = "http://127.0.0.1:18776/api/v1";
  const registrationCode = await fetch(apiBase + "/auth/register/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "package-peer@example.com" }),
  });
  expect(registrationCode.ok).toBe(true);
  const emailVerification = await registrationCode.json();
  const registration = await fetch(apiBase + "/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "发行包聊天伙伴",
      email: "package-peer@example.com",
      password: "TaskLink isolated media partner!2030",
      email_verification_id: emailVerification.request_id,
      email_verification_code: "246810",
    }),
  });
  expect(registration.ok).toBe(true);
  let peer = await registration.json();
  async function peerRequest(route, method = "GET", body) {
    const call = () =>
      fetch(apiBase + route, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + peer.access_token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let response = await call();
    if (response.status === 401) {
      const refreshed = await fetch(apiBase + "/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: peer.refresh_token }),
      });
      expect(refreshed.ok).toBe(true);
      peer = await refreshed.json();
      response = await call();
    }
    expect(response.ok).toBe(true);
    return response;
  }
  const friend = await page.evaluate(
    (email) => window.tasklink.invoke("friends.add", { email }),
    peer.user.email,
  );
  await peerRequest("/friends/" + friend.id + "/decision", "POST", {
    accept: true,
  });
  await page.evaluate(() => window.tasklink.invoke("sync.run", {}));
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.tasklink
          .invoke("friends.list", {})
          .then((items) =>
            items.some((friend) => friend.status === "accepted"),
          ),
      ),
    )
    .toBe(true);
  const [chat] = await Promise.all([
    browser.contexts()[0].waitForEvent("page"),
    page.getByRole("button", { name: "聊天", exact: true }).click(),
  ]);
  await chat
    .getByRole("button", { name: "与发行包聊天伙伴聊天", exact: true })
    .click();
  expect(browser.contexts()[0].pages()).toHaveLength(2);
  const user = await page.evaluate(() =>
    window.tasklink.invoke("auth.status", {}),
  );
  await peerRequest("/messages", "POST", {
    id: randomUUID(),
    recipient_id: user.id,
    body: "安装包内的独立聊天已连接。",
  });
  await expect(
    chat
      .locator(".chat-bubble")
      .getByText("安装包内的独立聊天已连接。", { exact: true }),
  ).toBeVisible();
  const file = path.join(dir, "packaged-attachment.txt");
  writeFileSync(file, "Actual packaged native File transfer " + randomUUID());
  await chat.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "packaged-test-file";
    document.body.appendChild(input);
  });
  // connectOverCDP may synthesize a File from bytes for setInputFiles. Use the
  // native DOM chooser command so Electron can verify its real disk backing.
  const cdp = await browser.contexts()[0].newCDPSession(chat);
  const { root: documentNode } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.nodeId,
    selector: "#packaged-test-file",
  });
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [file] });
  await cdp.detach();
  const drag = await chat.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(document.querySelector("#packaged-test-file").files[0]);
    return data;
  });
  await chat
    .locator(".chat-conversation")
    .dispatchEvent("drop", { dataTransfer: drag });
  await drag.dispose();
  await chat.locator("#packaged-test-file").evaluate((node) => node.remove());
  await expect(chat.locator(".chat-pending-file")).toHaveCount(1);
  await chat
    .getByLabel("消息内容", { exact: true })
    .fill("这是发行包真实传输的文件。");
  await chat.getByRole("button", { name: "发送", exact: true }).click();
  await expect(chat.locator(".chat-pending-file")).toHaveCount(0);
  await expect(chat.locator("html")).toHaveAttribute(
    "data-appearance",
    "winter-night",
  );
  await expect(chat.locator(".own .chat-bubble")).toHaveCSS(
    "background-color",
    "rgb(176, 197, 248)",
  );
  const messages = await (await peerRequest("/messages/" + user.id)).json();
  const attachment = messages.find((message) => message.attachments.length)
    .attachments[0];
  expect(
    Buffer.from(
      await (
        await peerRequest("/attachments/" + attachment.id + "/chunks/0")
      ).arrayBuffer(),
    ),
  ).toEqual(readFileSync(file));
  await chat.screenshot({
    path: path.join(dir, "packaged-chat.png"),
    scale: "css",
  });
  await chat.getByRole("button", { name: "关闭聊天窗口", exact: true }).click();
  await expect.poll(() => browser.contexts()[0].pages().length).toBe(1);
  report.packagedChat = {
    independentWindow: true,
    nativeFileDrop: true,
    actualRecipientBytes: true,
  };
  report.passed = true;
  report.version = value.version;
  report.forcedRestart = true;
  report.encryptedVault = true;
  report.expiredTokenSync = true;
} catch (error) {
  report.error = String(error);
  report.windows = [];
  for (const page of browser?.contexts()[0]?.pages() ?? []) {
    report.windows.push({
      url: page.url(),
      alerts: await page
        .locator('[role="alert"]')
        .allTextContents()
        .catch(() => []),
    });
    if (page.url().endsWith("#chat"))
      await page
        .screenshot({ path: path.join(dir, "chat-failure.png"), scale: "css" })
        .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await stop();
  if (server.exitCode === null) {
    const done = once(server, "exit");
    server.kill();
    await done;
  }
}
