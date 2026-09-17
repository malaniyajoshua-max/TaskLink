import { authGallery, capture, fullGallery } from "./gallery";
import { chatAcceptance } from "./chat-acceptance";
import { workspaceExperience } from "./workspace-experience";
import { productivity } from "./productivity";
import { seasonalThemes } from "../shared/themes";
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(".."),
  python = path.join(root, "server/.venv/Scripts/python.exe");
mkdirSync(path.join(root, "work/electron-e2e"), { recursive: true });
const dir = mkdtempSync(path.join(root, "work/electron-e2e/run-"));
const serverEnv = {
  ...process.env,
  TASKLINK_DATABASE_URL:
    "sqlite:///" + path.join(dir, "server.db").replaceAll("\\", "/"),
  TASKLINK_ENV: "test",
  TASKLINK_TEST_EMAIL_CODE: "246810",
};
let server: ChildProcess;
test.beforeAll(async () => {
  execFileSync(python, ["-m", "app.migrate"], {
    cwd: path.join(root, "server"),
    env: serverEnv,
    windowsHide: true,
  });
  server = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      "18766",
      "--no-access-log",
    ],
    {
      cwd: path.join(root, "server"),
      env: serverEnv,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://127.0.0.1:18766/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("API startup failed");
});
test.afterAll(async () => {
  if (server?.exitCode === null) {
    const exit = once(server, "exit");
    server.kill();
    await exit;
  }
});
test("chat: independent window, rich media, real drag/drop, secure save and draft restart", async () => {
  test.setTimeout(150000);
  await chatAcceptance(launch, dir, registerUI);
});
async function launch(profile: string) {
  const env = {
    ...process.env,
    TASKLINK_USER_DATA: path.join(dir, profile),
    TASKLINK_API_URL: "http://127.0.0.1:18766/api/v1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TASKLINK_DEV_URL;
  if (process.env.TASKLINK_E2E_DEV_URL)
    env.TASKLINK_DEV_URL = process.env.TASKLINK_E2E_DEV_URL;
  return electron.launch({
    executablePath:
      process.env.TASKLINK_E2E_EXECUTABLE ??
      path.resolve("node_modules/electron/dist/electron.exe"),
    args: process.env.TASKLINK_E2E_EXECUTABLE ? [] : ["."],
    env,
    cwd: process.cwd(),
  });
}
test("workspace: quick capture, IME, date context, board, undo, command search and unsaved protection", async () => {
  let app = await launch("workspace-experience");
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await registerUI(page, "体验验证", "workspace-experience@example.com");
    await workspaceExperience(app, page);
    expect(errors).toEqual([]);
    await app.close();
    app = await launch("workspace-experience");
    const restored = await app.firstWindow();
    await expect(
      restored.getByRole("heading", { name: "我的任务", exact: true }),
    ).toBeVisible();
    await expect(
      restored.getByRole("button", {
        name: "完成任务 中文输入不会误提交",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      restored.getByText("撤销期间到达的新描述", { exact: true }),
    ).toBeVisible();
    await expect(restored.locator("html")).toHaveAttribute(
      "data-theme",
      "dark",
    );
  } finally {
    await app.close();
  }
});

test("productivity: batch, duplicate, remembered views and focus pause/restart/real expiry", async () => {
  test.setTimeout(120000);
  let app = await launch("productivity");
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await registerUI(page, "效率验证", "productivity@example.com");
    const paused = await productivity(page);
    await app.close();
    app = await launch("productivity");
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator(".board-card")).toHaveCount(3);
    await expect(page.getByLabel("任务排序", { exact: true })).toHaveValue(
      "priority",
    );
    await page.getByRole("button", { name: "专注计时", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "继续专注", exact: true }),
    ).toBeVisible();
    const restored = await page.evaluate(() =>
      (window as any).tasklink.invoke("focus.get", {}),
    );
    expect(restored).toEqual(paused);
    await page.getByRole("button", { name: "继续专注", exact: true }).click();
    // Resume persists the absolute deadline even while the app is fully exited.
    await app.close();
    app = await launch("productivity");
    page = await app.firstWindow();
    await page.getByRole("button", { name: "专注计时", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "暂停", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByText("这一段专注完成了，休息一下吧。", { exact: true }),
    ).toBeVisible({ timeout: 65000 });
    await page.getByRole("button", { name: "专注计时", exact: true }).click();
    await expect(page.locator(".focus-record")).toContainText(
      "已完成 1 段专注",
    );
    for (let i = 0; i < 2; i++) {
      const state = await page.evaluate(() =>
        (window as any).tasklink.invoke("focus.get", {}),
      );
      expect(state.sessions).toBe(1);
      expect(state.focusedSeconds).toBe(60);
    }
    const task = await page.evaluate(
      (id) =>
        (window as any).tasklink
          .invoke("tasks.list", {})
          .then((tasks: any[]) => tasks.find((row: any) => row.id === id)),
      restored.taskId,
    );
    expect(task.body.status).toBe("todo");
    await page.getByRole("button", { name: "再来一轮", exact: true }).click();
    await page.getByRole("button", { name: "结束", exact: true }).click();
    await expect(
      page.getByText("结束本次计时？未完成的这一段不会计入专注记录。", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "结束本次", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "开始计时", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test("themes: eight seasonal palettes, live chat, compact previews and restart persistence", async () => {
  let app = await launch("seasonal-themes");
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await registerUI(page, "林间工作室", "seasonal-themes@example.com");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1380, 900),
    );
    await page.evaluate(async () => {
      const api = (window as any).tasklink;
      const due = new Date();
      due.setHours(18, 0, 0, 0);
      const project = await api.invoke("projects.save", {
        workspace_id: null,
        body: {
          name: "新一季的计划",
          description: "留一点时间，把重要的事做好。",
          color: "#739879",
          archived: false,
        },
      });
      for (const [title, status, priority] of [
        ["梳理本周的工作重点", "in_progress", "high"],
        ["完成产品视觉方案", "todo", "urgent"],
        ["和团队确认交付时间", "todo", "medium"],
        ["整理灵感与阅读笔记", "done", "low"],
      ])
        await api.invoke("tasks.save", {
          workspace_id: null,
          body: {
            title,
            status,
            priority,
            project_id: project.id,
            due_at: due.toISOString(),
            description: "从清晰的目标开始，专注完成每一步。",
          },
        });
    });
    const chatOpened = app.waitForEvent("window");
    await page.getByRole("button", { name: "聊天", exact: true }).click();
    const chat = await chatOpened;
    await chat.waitForLoadState("domcontentloaded");
    for (const theme of seasonalThemes) {
      await page
        .locator(".sidebar")
        .getByRole("button", { name: "设置", exact: true })
        .click();
      await expect(page.locator(".season-theme-card")).toHaveCount(8);
      await page
        .getByRole("button", { name: `选择${theme.name}`, exact: true })
        .click();
      await expect(page.locator("html")).toHaveAttribute(
        "data-appearance",
        theme.id,
      );
      await expect(chat.locator("html")).toHaveAttribute(
        "data-appearance",
        theme.id,
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        theme.mode,
      );
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--accent")
            .trim(),
        ),
      ).toBe(theme.colors.accent);
      await page.locator(".theme-picker").scrollIntoViewIfNeeded();
      await capture(
        page,
        `themes-${theme.id}-settings`,
        theme.name + " · 主题预览",
      );
      await page
        .locator(".sidebar")
        .getByRole("button", { name: "我的任务", exact: true })
        .click();
      await expect(page.locator(".task-row")).toHaveCount(4);
      await capture(page, `themes-${theme.id}`, theme.name + " · 工作台");
      await page
        .locator(".task-row")
        .filter({ hasText: "完成产品视觉方案" })
        .locator(".task-copy")
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
        "完成产品视觉方案",
      );
      await page.keyboard.press("Escape");
      await page
        .locator(".sidebar")
        .getByRole("button", { name: "日历", exact: true })
        .click();
      await expect(page.locator(".calendar-grid")).toBeVisible();
      await capture(
        page,
        `themes-${theme.id}-calendar`,
        theme.name + " · 日历",
      );
    }
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await page.getByLabel("界面主题", { exact: true }).selectOption("light");
    await expect(page.locator("html")).not.toHaveAttribute("data-season");
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--accent"),
      ),
    ).toBe("");
    await expect(chat.locator("html")).not.toHaveAttribute("data-season");
    await page
      .getByRole("button", { name: "选择秋 · 暮火", exact: true })
      .click();
    await expect(chat.locator("html")).toHaveAttribute(
      "data-appearance",
      "autumn-night",
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => !win.webContents.getURL().includes("#chat"))!
        .setContentSize(1000, 760),
    );
    await page.locator(".theme-picker").scrollIntoViewIfNeeded();
    await capture(page, "themes-compact", "紧凑窗口 · 四季主题");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    await app.close();
    app = await launch("seasonal-themes");
    page = await app.firstWindow();
    await expect(page.locator("html")).toHaveAttribute(
      "data-appearance",
      "autumn-night",
    );
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "选择秋 · 暮火", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  } finally {
    await app.close();
  }
});
test("task family: list completion, exact undo, editor aggregation, board and reminder guidance", async () => {
  const app = await launch("task-family");
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await registerUI(page, "联动验证", "task-family@example.com");
    expect(page.url()).toBe("tasklink://app/index.html");
    expect(await page.title()).toContain("TaskLink");
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await page.getByLabel("标题", { exact: true }).fill("发布准备");
    await page.keyboard.press("Control+Enter");
    await page.evaluate(async () => {
      const api = (window as any).tasklink;
      const parent = (await api.invoke("tasks.list", {}))[0];
      for (const [title, status] of [
        ["检查安装包", "todo"],
        ["整理说明", "in_progress"],
      ])
        await api.invoke("tasks.save", {
          workspace_id: null,
          body: { ...parent.body, title, status, parent_id: parent.id },
        });
      return parent.id as string;
    });
    await page
      .getByRole("button", { name: "完成任务 发布准备", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "联动更新 2 个关联任务" }),
    ).toBeVisible();
    const states = () =>
      page.evaluate(async () =>
        (await (window as any).tasklink.invoke("tasks.list", {}))
          .map((task: any) => [task.body.title, task.body.status])
          .sort(),
      );
    await expect.poll(states).toEqual(
      [
        ["发布准备", "done"],
        ["整理说明", "done"],
        ["检查安装包", "done"],
      ].sort(),
    );
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(states).toEqual(
      [
        ["发布准备", "todo"],
        ["整理说明", "in_progress"],
        ["检查安装包", "todo"],
      ].sort(),
    );
    await page
      .locator(".task-row")
      .filter({ hasText: "发布准备" })
      .locator(".task-copy")
      .click();
    await page
      .getByRole("button", { name: "完成子任务 检查安装包", exact: true })
      .click();
    await page
      .getByRole("button", { name: "完成子任务 整理说明", exact: true })
      .click();
    await expect(page.getByLabel("状态", { exact: true })).toHaveValue("done");
    await expect(page.getByText(/完成父任务会完成全部子任务/)).toBeVisible();
    await capture(page, "family-completed", "父子任务完成联动");
    await page.getByRole("button", { name: "保存任务", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "看板", exact: true }).click();
    const card = page.locator(".board-card").filter({ hasText: "发布准备" });
    await card.locator("select").selectOption("in_progress");
    await expect.poll(states).toEqual(
      [
        ["发布准备", "in_progress"],
        ["整理说明", "todo"],
        ["检查安装包", "todo"],
      ].sort(),
    );
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await expect(page.getByText(/声音由 Windows 通知设置控制/)).toBeVisible();
    await page
      .getByText(/声音由 Windows 通知设置控制/)
      .scrollIntoViewIfNeeded();
    await capture(page, "reminder-guidance", "提醒运行条件");
    expect(errors).toEqual([]);
    expect(await page.locator("vite-error-overlay").count()).toBe(0);
  } finally {
    await app.close();
  }
});
test("authentication: real production window, sandbox, preload and authentication form", async () => {
  const app = await launch("smoke");
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "欢迎回来", exact: true }),
    ).toBeVisible();
    expect(page.url()).toBe(
      process.env.TASKLINK_E2E_DEV_URL
        ? process.env.TASKLINK_E2E_DEV_URL + "/"
        : "tasklink://app/index.html",
    );
    const options = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    );
    expect(options.sandbox).toBe(true);
    expect(options.contextIsolation).toBe(true);
    expect(options.nodeIntegration).toBe(false);
    const isolated = await page.evaluate(() => ({
      node: typeof (window as any).require,
      process: typeof (window as any).process,
      api: Object.keys((window as any).tasklink),
    }));
    expect(isolated.node).toBe("undefined");
    expect(isolated.process).toBe("undefined");
    expect(isolated.api.sort()).toEqual([
      "invoke",
      "onChatPeer",
      "onTransfer",
      "stageFiles",
      "subscribe",
    ]);
    const denied = await page.evaluate(async () => {
      const attempt = async (command: string, input: unknown) => {
        try {
          await (window as any).tasklink.invoke(command, input);
          return false;
        } catch {
          return true;
        }
      };
      return Promise.all([
        attempt("file.restore", { path: "C:/Windows" }),
        attempt("data.backup", { path: "C:/Windows" }),
        attempt("auth.status", { token: "unexpected" }),
      ]);
    });
    expect(denied).toEqual([true, true, true]);
    const csp = await page.evaluate(async () => {
      const script = document.createElement("script");
      script.textContent = "window.__cspProbe = true";
      document.body.append(script);
      let blocked = false;
      try {
        await fetch("http://127.0.0.1:18766/health");
      } catch {
        blocked = true;
      }
      return { inline: (window as any).__cspProbe, blocked };
    });
    expect(csp).toEqual({ inline: undefined, blocked: true });
    await expect(page.getByLabel("账号 / 邮箱", { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(dir, "login.png") });
  } finally {
    await app.close();
  }
});

test("security: first-launch forced termination preserves DPAPI credentials and encrypted outbox", async () => {
  let app = await launch("first-launch-crash");
  let page = await app.firstWindow();
  try {
    const created = await page.evaluate(async () => {
      const api = (window as any).tasklink;
      const verification = await api.invoke("auth.registrationCode", {
        email: "first-launch-crash@example.com",
      });
      const user = await api.invoke("auth.register", {
        email: "first-launch-crash@example.com",
        name: "中断恢复验证",
        email_verification_id: verification.request_id,
        email_verification_code: "246810",
        password: "TaskLink isolated crash test!2030",
      });
      await api.invoke("sync.pause", { paused: true });
      const task = await api.invoke("tasks.save", {
        workspace_id: null,
        body: { title: "首次强制中断后必须恢复" },
      });
      return { userId: user.id, taskId: task.id };
    });
    const process = app.process(),
      closed = once(process, "exit");
    execFileSync("taskkill", ["/PID", String(process.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await closed;
    await app.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (const file of ["credentials.bin", "storage-key.bin"])
      expect(
        readFileSync(path.join(dir, "first-launch-crash", file))
          .subarray(0, 5)
          .toString(),
      ).toBe("TLDP1");
    app = await launch("first-launch-crash");
    page = await app.firstWindow();
    const restored = await page.evaluate(async () => ({
      user: await (window as any).tasklink.invoke("auth.status", {}),
      tasks: await (window as any).tasklink.invoke("tasks.list", {}),
      sync: await (window as any).tasklink.invoke("sync.status", {}),
    }));
    expect(restored.user.id).toBe(created.userId);
    expect(restored.tasks[0].id).toBe(created.taskId);
    expect(restored.sync.pending).toBe(1);
    expect(restored.sync.paused).toBe(true);
  } finally {
    // This test deliberately exercises termination, including final cleanup.
    // A disconnected first CDP context must not keep the test awaiting close.
    const process = app.process();
    if (process.exitCode === null) {
      const closed = once(process, "exit");
      execFileSync("taskkill", ["/PID", String(process.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      await closed;
    }
  }
});

test("accounts: logout isolates accounts and offline records return only to their owner", async () => {
  let app = await launch("isolation"),
    page = await app.firstWindow();
  try {
    await registerUI(page, "隔离甲", "isolation-a@example.com");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "暂停同步", exact: true }).click();
    await page.getByRole("button", { name: "我的任务", exact: true }).click();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await page.getByLabel("标题", { exact: true }).fill("甲的未同步私人任务");
    await page.getByRole("button", { name: "保存任务", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /甲的未同步私人任务 待办/ }),
    ).toBeVisible();
    await app.close();
    app = await launch("isolation");
    page = await app.firstWindow();
    const status = await page.evaluate(() =>
      (window as any).tasklink.invoke("sync.status", {}),
    );
    expect(status.paused).toBe(true);
    expect(status.pending).toBe(1);
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page
      .getByRole("button", { name: "确认退出登录", exact: true })
      .click();
    await registerUI(page, "隔离乙", "isolation-b@example.com");
    await expect(page.locator(".task-row")).toHaveCount(0);
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page
      .getByRole("button", { name: "确认退出登录", exact: true })
      .click();
    await page
      .getByLabel("账号 / 邮箱", { exact: true })
      .fill("isolation-a@example.com");
    await page
      .getByLabel("密码", { exact: true })
      .fill("correct horse battery");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /甲的未同步私人任务 待办/ }),
    ).toBeVisible();
    const privateData = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }));
    expect(privateData).toEqual({ local: [], session: [] });
  } finally {
    await app.close();
  }
});
test("tasks: account, tasks/subtasks, projects, calendar, restart and settings", async () => {
  let app = await launch("alice");
  let page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.getByRole("button", { name: "注册账号", exact: true }).click();
    await page.getByLabel("昵称", { exact: true }).fill("桌面验收");
    await page
      .getByLabel("绑定邮箱", { exact: true })
      .fill("desktop@example.com");
    await page.getByRole("button", { name: "发送验证码", exact: true }).click();
    await expect(page.getByRole("button", { name: /秒后重发/ })).toBeVisible();
    await page.getByLabel("邮箱验证码", { exact: true }).fill("246810");
    await page
      .getByLabel("密码", { exact: true })
      .fill("correct horse battery");
    await page
      .getByLabel("确认密码", { exact: true })
      .fill("correct horse battery");
    await page.getByRole("button", { name: "注册账号", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "账号创建成功", exact: true }),
    ).toBeVisible();
    const accountId = await page.locator(".account-id-card strong").innerText();
    expect(accountId).toMatch(/^TL-\d{4}-\d{4}$/);
    await page.getByRole("button", { name: "复制账号", exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      accountId,
    );
    await page.getByRole("button", { name: "开始使用", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "我的任务", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await page.getByLabel("标题", { exact: true }).fill("验收任务");
    await page.getByLabel("描述", { exact: true }).fill("通过真实桌面操作保存");
    await page.getByLabel("优先级", { exact: true }).selectOption("high");
    await page.getByLabel("开始时间", { exact: true }).fill("2030-02-02T18:00");
    await page.getByLabel("截止时间", { exact: true }).fill("2030-02-01T18:00");
    await page.getByRole("button", { name: "保存任务", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "截止时间不能早于开始时间",
    );
    await page.getByLabel("截止时间", { exact: true }).fill("2030-02-03T18:00");
    await page.getByRole("button", { name: "保存任务", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /验收任务 通过真实桌面/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /验收任务 通过真实桌面/ }).click();
    await page.getByLabel("标题", { exact: true }).fill("验收任务已编辑");
    await page.getByRole("button", { name: "保存任务", exact: true }).click();
    await page
      .getByRole("button", { name: /验收任务已编辑 通过真实桌面/ })
      .click();
    await page.getByRole("button", { name: "添加子任务", exact: true }).click();
    await expect(page.getByLabel("标题", { exact: true })).toHaveValue("");
    await expect(
      page.getByLabel("跟随父任务截止时间", { exact: true }),
    ).toBeChecked();
    await page.getByLabel("标题", { exact: true }).fill("第一项子任务");
    await page.getByRole("button", { name: "保存任务", exact: true }).click();
    const hierarchy = await page.evaluate(() =>
      (window as any).tasklink.invoke("tasks.list", {}),
    );
    expect(
      hierarchy.find((t: any) => t.body.title === "第一项子任务").body
        .parent_id,
    ).toBe(hierarchy.find((t: any) => t.body.title === "验收任务已编辑").id);
    await page
      .getByRole("button", { name: "完成任务 验收任务已编辑", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "恢复任务 验收任务已编辑",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel("搜索任务", { exact: true }).fill("已编辑");
    await page.getByRole("tab", { name: /已完成/ }).click();
    await page.getByLabel("优先级筛选", { exact: true }).selectOption("high");
    await expect(page.locator(".task-row")).toHaveCount(1);
    await page.getByLabel("搜索任务", { exact: true }).fill("找不到的任务");
    await expect(
      page.getByRole("heading", {
        name: "没有找到符合条件的任务",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await expect(page.getByLabel("搜索任务", { exact: true })).toHaveValue("");
    await expect(page.getByRole("tab", { name: /全部/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await app.close();
    app = await launch("alice");
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", {
        name: "恢复任务 验收任务已编辑",
        exact: true,
      }),
    ).toBeVisible();
    const user = await page.evaluate(() =>
      (window as any).tasklink.invoke("auth.status", {}),
    );
    expect(Object.keys(user).sort()).toEqual([
      "account_id",
      "avatar",
      "email",
      "id",
      "name",
    ]);
    const vault = readFileSync(
      path.join(dir, "alice", "credentials.bin"),
      "utf8",
    );
    expect(vault).not.toContain("access_token");
    expect(vault).not.toContain("desktop@example.com");
    await page.getByRole("button", { name: "项目", exact: true }).click();
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    await page.getByLabel("项目名称", { exact: true }).fill("发布准备");
    await page.getByRole("button", { name: "保存项目", exact: true }).click();
    await page.getByRole("button", { name: /发布准备 查看项目任务/ }).click();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await page.getByLabel("标题", { exact: true }).fill("项目关联任务");
    const today = new Date();
    const todayInput = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-");
    await page
      .getByLabel("截止时间", { exact: true })
      .fill(todayInput + "T18:00");
    await page.getByRole("button", { name: "保存任务", exact: true }).click();
    await page.getByRole("button", { name: "日历", exact: true }).click();
    await expect(
      page
        .locator(".calendar-task")
        .filter({ hasText: "项目关联任务" })
        .first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "修改昵称", exact: true }).click();
    await page.getByLabel("新昵称", { exact: true }).fill("桌面验收已更新");
    await page.getByRole("button", { name: "保存昵称", exact: true }).click();
    await expect(page.locator(".profile-copy b")).toHaveText("桌面验收已更新");
    expect(
      await page.evaluate(() =>
        (window as any).tasklink
          .invoke("auth.status", {})
          .then((current: any) => current.name),
      ),
    ).toBe("桌面验收已更新");
    const avatarFile = path.join(dir, "settings-avatar.png");
    writeFileSync(
      avatarFile,
      new Resvg(
        '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="32" fill="#dfe3ff"/><circle cx="64" cy="50" r="25" fill="#edbd9e"/><path d="M16 128q4-51 48-51t48 51" fill="#515dec"/></svg>',
      )
        .render()
        .asPng(),
    );
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [file],
      })) as any;
    }, avatarFile);
    await page.getByRole("button", { name: "更换头像", exact: true }).click();
    await expect(page.locator(".profile-setting img")).toBeVisible();
    await page.getByLabel("界面主题", { exact: true }).selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: path.join(dir, "settings.png") });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

async function registerUI(
  page: Page,
  name: string,
  email: string,
  beforeContinue?: () => Promise<void>,
) {
  await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await page.getByLabel("昵称", { exact: true }).fill(name);
  await page.getByLabel("绑定邮箱", { exact: true }).fill(email);
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  await expect(page.getByRole("button", { name: /秒后重发/ })).toBeVisible();
  await page.getByLabel("邮箱验证码", { exact: true }).fill("246810");
  await page.getByLabel("密码", { exact: true }).fill("correct horse battery");
  await page
    .getByLabel("确认密码", { exact: true })
    .fill("correct horse battery");
  await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "账号创建成功", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await beforeContinue?.();
  await page.getByRole("button", { name: "开始使用", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "我的任务", exact: true }),
  ).toBeVisible({ timeout: 15000 });
}
async function syncUI(page: Page) {
  await page.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).tasklink
          .invoke("sync.status", {})
          .then((s: any) => s.state),
      ),
    )
    .not.toBe("syncing");
}
test("data: actual export/import/backup/restore through desktop commands", async () => {
  const app = await launch("files");
  const page = await app.firstWindow();
  try {
    await registerUI(page, "文件验收", "files@example.com");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "暂停同步", exact: true }).click();
    await page.getByRole("button", { name: "我的任务", exact: true }).click();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await page.getByLabel("标题", { exact: true }).fill("离线文件验收");
    await page.getByRole("button", { name: "保存任务", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    // Deterministic file selection only; production IPC, validation and file I/O are exercised.
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showMessageBox = (async () => ({
          response: 1,
          checkboxChecked: false,
        })) as any;
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: file,
        })) as any;
      },
      path.join(dir, "export.json"),
    );
    await page.getByRole("button", { name: "导出数据", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "数据已导出" }),
    ).toBeVisible();
    expect(
      JSON.parse(readFileSync(path.join(dir, "export.json"), "utf8")).documents,
    ).toHaveLength(1);
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: file,
        })) as any;
      },
      path.join(dir, "backup.tlbackup"),
    );
    await page.getByRole("button", { name: "创建备份", exact: true }).click();
    await page
      .getByLabel("备份口令", { exact: true })
      .fill("isolated backup acceptance phrase");
    await page
      .getByLabel("确认口令", { exact: true })
      .fill("isolated backup acceptance phrase");
    await page.getByRole("button", { name: "选择文件", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "加密备份已创建" }),
    ).toBeVisible();
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [file],
        })) as any;
      },
      path.join(dir, "export.json"),
    );
    await page.getByRole("button", { name: "导入数据", exact: true }).click();
    await expect(
      page.getByText("已导入 1 项记录。", { exact: true }),
    ).toBeVisible();
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [file],
        })) as any;
        dialog.showMessageBox = (async () => ({
          response: 1,
          checkboxChecked: false,
        })) as any;
      },
      path.join(dir, "backup.tlbackup"),
    );
    await page.getByRole("button", { name: "从备份恢复", exact: true }).click();
    await page
      .getByLabel("备份口令", { exact: true })
      .fill("isolated backup acceptance phrase");
    await page.getByRole("button", { name: "选择文件", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "数据已从备份恢复" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "我的任务", exact: true }).click();
    await expect(page.locator(".task-row")).toHaveCount(1);
    await page.screenshot({ path: path.join(dir, "data-tools.png") });
  } finally {
    await app.close();
  }
});
test("collaboration: two desktop users, workspace invitation, server role, friend consent and chat catch-up", async () => {
  const a = await launch("collab-a"),
    b = await launch("collab-b");
  const pa = await a.firstWindow(),
    pb = await b.firstWindow();
  try {
    await registerUI(pa, "工作区所有者", "owner-ui@example.com");
    await registerUI(pb, "协作成员", "member-ui@example.com");
    await pa.getByRole("button", { name: "协作", exact: true }).click();
    await pa.getByRole("button", { name: "创建工作区", exact: true }).click();
    await pa.getByLabel("名称", { exact: true }).fill("协作验收空间");
    await pa.getByRole("button", { name: "创建", exact: true }).click();
    await expect(
      pa.getByRole("button", { name: /协作验收空间 所有者/ }),
    ).toBeVisible();
    await pa.getByRole("button", { name: /协作验收空间 所有者/ }).click();
    await pa.getByLabel("邮箱", { exact: true }).fill("member-ui@example.com");
    await pa.getByRole("button", { name: "发送邀请", exact: true }).click();
    await expect(pa.getByLabel("邮箱", { exact: true })).toHaveValue("");
    await pa.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await pb.getByRole("button", { name: "协作", exact: true }).click();
    await expect(
      pb.getByRole("button", { name: "接受", exact: true }),
    ).toBeVisible();
    await pb.getByRole("button", { name: "接受", exact: true }).click();
    await expect(
      pb.getByRole("button", { name: /协作验收空间 成员/ }),
    ).toBeVisible();
    await pa
      .getByLabel("好友邮箱", { exact: true })
      .fill("member-ui@example.com");
    await pa.getByRole("button", { name: "申请", exact: true }).click();
    await syncUI(pb);
    await expect(
      pb.getByRole("button", { name: "接受", exact: true }),
    ).toBeVisible();
    await pb.getByRole("button", { name: "接受", exact: true }).click();
    await syncUI(pa);
    const [chatA] = await Promise.all([
      a.waitForEvent("window"),
      pa
        .locator(".contact-button")
        .filter({ hasText: "member-ui@example.com" })
        .click(),
    ]);
    await chatA
      .getByLabel("消息内容", { exact: true })
      .fill("真实双窗口协作消息");
    await chatA.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      chatA
        .locator(".chat-bubble")
        .getByText("真实双窗口协作消息", { exact: true }),
    ).toBeVisible();
    await syncUI(pb);
    const [chatB] = await Promise.all([
      b.waitForEvent("window"),
      pb
        .locator(".contact-button")
        .filter({ hasText: "owner-ui@example.com" })
        .click(),
    ]);
    await expect(
      chatB
        .locator(".chat-bubble")
        .getByText("真实双窗口协作消息", { exact: true }),
    ).toBeVisible();
    await chatB.screenshot({ path: path.join(dir, "chat.png") });
    await pa
      .getByLabel("切换工作区", { exact: true })
      .selectOption({ label: "协作验收空间" });
    await pa.getByRole("button", { name: "我的任务", exact: true }).click();
    await pa.getByRole("button", { name: "新建任务", exact: true }).click();
    await pa.getByLabel("标题", { exact: true }).fill("团队共享任务");
    await pa.getByRole("button", { name: "保存任务", exact: true }).click();
    await syncUI(pa);
    await syncUI(pb);
    await pb
      .getByLabel("切换工作区", { exact: true })
      .selectOption({ label: "协作验收空间" });
    await pb.getByRole("button", { name: "我的任务", exact: true }).click();
    await expect(
      pb.getByRole("button", { name: /团队共享任务 待办/ }),
    ).toBeVisible();
    await pb.getByRole("button", { name: "通知中心", exact: true }).click();
    await expect(
      pb.getByRole("button", { name: "全部标为已读", exact: true }),
    ).toBeVisible();
    await pb.getByRole("button", { name: "全部标为已读", exact: true }).click();
    await expect(
      pb.getByRole("button", { name: "全部标为已读", exact: true }),
    ).toHaveCount(0);
  } finally {
    await a.close();
    await b.close();
  }
});

test("design: populated task list, drawer, compact window and dark theme", async () => {
  test.setTimeout(240000);
  const app = await launch("design");
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1380, 860),
    );
    await authGallery(page, app);
    await registerUI(page, "林然", "design-review@example.com", () =>
      capture(page, "45-account-created", "账号创建成功"),
    );
    await page.evaluate(async () => {
      const api = (window as any).tasklink;
      await api.invoke("settings.set", {
        theme: "light",
        notifications: false,
        closeToTray: true,
      });
      const product = await api.invoke("projects.save", {
        workspace_id: null,
        body: {
          name: "产品迭代",
          description: "从需求梳理到发布，把每一步计划落到实处。",
          color: "#6271dc",
        },
      });
      const personal = await api.invoke("projects.save", {
        workspace_id: null,
        body: {
          name: "个人成长",
          description: "为阅读、学习和更好的生活留一点时间。",
          color: "#4fa78b",
        },
      });
      const titles = [
        "完成产品需求文档",
        "整理本周设计反馈",
        "准备周五团队例会",
        "阅读《设计心理学》",
        "更新项目里程碑",
        "整理工作空间",
      ];
      const descriptions = [
        "梳理核心功能，补充业务流程和边界说明",
        "汇总评审意见，形成设计优化清单",
        "准备汇报材料与讨论议题",
        "第 3–4 章，记录阅读笔记",
        "调整里程碑时间与交付物",
        "清理桌面文件与文档",
      ];
      const priorities = ["high", "medium", "high", "low", "medium", "low"];
      const statuses = [
        "in_progress",
        "todo",
        "todo",
        "in_progress",
        "todo",
        "done",
      ];
      for (let index = 0; index < titles.length; index++) {
        const due = new Date();
        due.setHours(18, 0, 0, 0);
        due.setDate(due.getDate() + index);
        const reminder = new Date(due);
        reminder.setMinutes(30);
        reminder.setHours(17);
        const saved = await api.invoke("tasks.save", {
          workspace_id: null,
          body: {
            title: titles[index],
            description: descriptions[index],
            priority: priorities[index],
            status: statuses[index],
            project_id: index === 3 || index === 5 ? personal.id : product.id,
            due_at: due.toISOString(),
            reminder_at: index === 0 ? reminder.toISOString() : null,
          },
        });
        if (index === 0) {
          for (const [title, status] of [
            ["梳理核心功能", "done"],
            ["补充边界说明", "todo"],
          ]) {
            await api.invoke("tasks.save", {
              workspace_id: null,
              body: {
                title,
                status,
                parent_id: saved.id,
                project_id: product.id,
                inherit_due: true,
                inherit_priority: true,
              },
            });
          }
        }
      }
    });
    await syncUI(page);
    await expect(page.locator(".task-row")).toHaveCount(6);
    await expect(page.getByRole("tab", { name: /全部/ })).toHaveText("全部6");
    await page.getByRole("tab", { name: /全部/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: /待办/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator(".task-row")).toHaveCount(3);
    await page.keyboard.press("Home");
    await expect(page.locator(".task-row")).toHaveCount(6);
    await page.getByRole("heading", { name: "我的任务" }).click();
    await page.screenshot({
      path: path.join(dir, "design-tasks-light.png"),
      scale: "css",
    });
    await page
      .getByRole("button", { name: /完成产品需求文档 梳理核心/ })
      .click();
    await expect(page.getByRole("dialog", { name: "编辑任务" })).toBeVisible();
    await page.screenshot({
      path: path.join(dir, "design-task-editor.png"),
      scale: "css",
    });
    await page.getByLabel("标题", { exact: true }).fill("尚未保存的改动");
    await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await expect(page.getByText("要放弃尚未保存的修改吗？")).toBeVisible();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /完成产品需求文档 梳理核心/ }),
    ).toBeVisible();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1586, 992),
    );
    await page.screenshot({
      path: path.join(dir, "design-native-size.png"),
      scale: "css",
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(980, 700),
    );
    expect(
      await page
        .locator(".page")
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await expect(page.locator(".profile")).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "设置", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: path.join(dir, "design-compact.png"),
      scale: "css",
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1380, 860),
    );
    await page.getByRole("button", { name: "项目", exact: true }).click();
    await expect(page.locator(".project-card")).toHaveCount(2);
    await page.screenshot({
      path: path.join(dir, "design-projects.png"),
      scale: "css",
    });
    await page.getByRole("button", { name: "日历", exact: true }).click();
    await expect(page.locator(".day")).toHaveCount(42);
    await page.screenshot({
      path: path.join(dir, "design-calendar.png"),
      scale: "css",
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.screenshot({
      path: path.join(dir, "design-settings.png"),
      scale: "css",
    });
    await page.getByLabel("界面主题", { exact: true }).selectOption("dark");
    await page.getByRole("button", { name: "我的任务", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({
      path: path.join(dir, "design-tasks-dark.png"),
      scale: "css",
    });
    await fullGallery(app, page, serverEnv, python);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
