import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { Network } from "../electron/network";

export const galleryDirectory =
  process.env.TASKLINK_GALLERY_DIR ??
  path.join(os.tmpdir(), "tasklink-ui-review");
const entries: { file: string; title: string }[] = [];
export async function capture(page: Page, file: string, title: string) {
  mkdirSync(galleryDirectory, { recursive: true });
  await page.bringToFront();
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() =>
      Array.from(document.images).every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
    ),
  ).toBe(true);
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: path.join(galleryDirectory, file + ".png"),
    scale: "css",
    animations: "disabled",
  });
  entries.push({ file: file + ".png", title });
  writeFileSync(
    path.join(galleryDirectory, "index.json"),
    JSON.stringify(entries, null, 2),
  );
}
export async function authGallery(page: Page, app: ElectronApplication) {
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
  await capture(page, "01-login", "登录");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1536, 1024),
  );
  await capture(page, "40-native-login", "登录页与设计稿同尺寸对照");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1380, 860),
  );
  await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await capture(page, "02-register", "注册");
  await page
    .getByLabel("绑定邮箱", { exact: true })
    .fill("gallery-verification@example.com");
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  await expect(page.getByRole("button", { name: /秒后重发/ })).toBeVisible();
  await page.getByLabel("邮箱验证码", { exact: true }).fill("246810");
  await capture(page, "43-registration-email-code", "注册邮箱验证码");
  await page.getByRole("button", { name: "返回登录", exact: true }).click();
  await page.getByRole("button", { name: "忘记密码？", exact: true }).click();
  await capture(page, "41-password-recovery", "找回密码");
  await page
    .getByLabel("绑定邮箱", { exact: true })
    .fill("gallery-recovery@example.com");
  await page.getByRole("button", { name: "发送验证码", exact: true }).click();
  await capture(page, "44-password-email-code", "密码找回邮箱验证码");
  await page.getByRole("button", { name: "更换邮箱", exact: true }).click();
  await page.getByRole("button", { name: "返回登录", exact: true }).click();
}
async function invoke(page: Page, command: string, input: unknown = {}) {
  return page.evaluate(
    ([command, input]) => (window as any).tasklink.invoke(command, input),
    [command, input],
  );
}
async function sync(page: Page) {
  await invoke(page, "sync.run");
  await expect
    .poll(() => invoke(page, "sync.status").then((s) => s.state), {
      timeout: 30000,
    })
    .toBe("idle");
  await expect
    .poll(() => invoke(page, "sync.status").then((s) => s.pending), {
      timeout: 30000,
    })
    .toBe(0);
}
async function navigate(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
  await page.locator(".page").evaluate((node) => (node.scrollTop = 0));
}
const close = (page: Page) =>
  page.getByRole("button", { name: "关闭对话框", exact: true }).click();

export async function fullGallery(
  app: ElectronApplication,
  page: Page,
  serverEnv: NodeJS.ProcessEnv,
  python: string,
) {
  await invoke(page, "settings.set", {
    theme: "light",
    notifications: false,
    notificationPreview: false,
    closeToTray: true,
  });
  await navigate(page, "我的任务");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await capture(page, "03-tasks", "我的任务");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1536, 1024),
  );
  await capture(page, "39-native-tasks", "任务页与设计稿同尺寸对照");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: ".task-open strong",
  });
  const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  expect(
    fonts.fonts.some(
      (font) => font.isCustomFont && font.familyName.includes("Noto Sans SC"),
    ),
  ).toBe(true);
  const typography = await page.evaluate(() =>
    [
      ".brand strong",
      ".nav-btn",
      ".page-heading h2",
      ".task-open strong",
      ".task-open small",
      ".primary",
      ".task-columns",
    ].map((selector) => {
      const node = document.querySelector(selector)!;
      const css = getComputedStyle(node);
      return {
        selector,
        font: css.fontFamily,
        size: css.fontSize,
        weight: css.fontWeight,
        lineHeight: css.lineHeight,
      };
    }),
  );
  writeFileSync(
    path.join(galleryDirectory, "typography.json"),
    JSON.stringify({ fonts, typography }, null, 2),
  );
  await cdp.detach();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1380, 860),
  );
  await page.getByRole("button", { name: /完成产品需求文档 梳理核心/ }).click();
  await capture(page, "04-task-detail", "任务详情与子任务");
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page
    .getByRole("button", { name: "确认删除", exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, "05-task-delete", "删除任务确认");
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "添加子任务", exact: true }).click();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue("");
  await expect(
    page.getByLabel("跟随父任务截止时间", { exact: true }),
  ).toBeChecked();
  await capture(page, "06-subtask-create", "新建子任务与属性继承");
  await close(page);
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("梳理下一轮产品改进清单");
  await capture(page, "07-task-create", "新建任务");
  await close(page);
  await expect(page.getByText("要放弃尚未保存的修改吗？")).toBeVisible();
  await capture(page, "08-unsaved", "未保存修改保护");
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await navigate(page, "今日");
  await capture(page, "09-today", "今日与逾期");
  await navigate(page, "即将到期");
  await capture(page, "10-upcoming", "即将到期");
  await navigate(page, "项目");
  await capture(page, "11-projects", "项目");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("季度计划");
  await capture(page, "12-project-create", "新建项目");
  await close(page);
  await expect(page.getByText("要放弃尚未保存的项目修改吗？")).toBeVisible();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await page
    .getByRole("button", { name: "编辑项目 产品迭代", exact: true })
    .click();
  await capture(page, "13-project-edit", "编辑项目");
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await capture(page, "14-project-delete", "删除项目确认");
  await close(page);
  await page.locator(".project-open").filter({ hasText: "产品迭代" }).click();
  await capture(page, "15-project-tasks", "项目任务");
  await navigate(page, "日历");
  await capture(page, "16-calendar", "月历");
  await page.locator(".calendar-title").click();
  await expect(page.getByRole("dialog", { name: "选择年月" })).toBeVisible();
  await capture(page, "42-calendar-picker", "自由选择年份和月份");
  await page.getByLabel("年份", { exact: true }).fill("2032");
  await page.getByRole("button", { name: "三月", exact: true }).click();
  await expect(page.locator(".calendar-title")).toContainText("2032年3月");
  await expect(page.getByLabel("选中日期日程")).toContainText("3月1日");
  await capture(page, "43-calendar-2032", "跳转到指定年月");
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await page.locator(".day.today .calendar-day-add").click();
  await capture(page, "17-calendar-create", "从日历创建任务");
  await close(page);
  const due = new Date();
  due.setHours(18, 0, 0, 0);
  for (const title of [
    "设计例会",
    "交互走查",
    "整理用户访谈",
    "核对发布清单",
    "文档校对",
    "计划复盘",
  ])
    await invoke(page, "tasks.save", {
      workspace_id: null,
      body: { title, due_at: due.toISOString() },
    });
  await sync(page);
  await expect(page.locator(".day.today .calendar-overflow")).toBeVisible();
  await page.locator(".day.today .calendar-overflow").click();
  await capture(page, "18-calendar-day", "日历当天的全部任务");
  await page.getByRole("button", { name: "关闭日程侧栏", exact: true }).click();
  await navigate(page, "提醒");
  await capture(page, "19-reminders", "提醒");

  const peer = new Network(
    "http://127.0.0.1:18766/api/v1",
    { current: null, revocations: [] },
    async () => {},
  );
  const colleagueVerification = await peer.requestRegistrationCode({
    email: "gallery-colleague@example.com",
  });
  const colleague = await peer.login("register", {
    email: "gallery-colleague@example.com",
    name: "陈安",
    email_verification_id: colleagueVerification.request_id,
    email_verification_code: "246810",
    password: "correct horse battery",
  });
  const user = await invoke(page, "auth.status");
  const workspace = await invoke(page, "workspaces.create", {
    name: "设计协作组",
  });
  await invoke(page, "workspaces.invite", {
    id: workspace.id,
    email: colleague.email,
    role: "member",
  });
  const invitation = (await peer.request<any[]>("/invitations"))[0];
  await peer.request("/invitations/" + invitation.id + "/decision", "POST", {
    accept: true,
  });
  const invited = await peer.request<any>("/workspaces", "POST", {
    name: "产品工作室",
  });
  await peer.request("/workspaces/" + invited.id + "/invites", "POST", {
    email: user.email,
    role: "member",
  });
  const friendship = await invoke(page, "friends.add", {
    email: colleague.email,
  });
  await peer.request("/friends/" + friendship.id + "/decision", "POST", {
    accept: true,
  });
  await invoke(page, "messages.send", {
    recipient_id: colleague.id,
    body: "交互评审已完成，反馈已经整理到项目中。",
  });
  await peer.request("/messages", "POST", {
    id: randomUUID(),
    recipient_id: user.id,
    body: "收到，我会补上可用性测试的记录。",
  });
  await sync(page);
  await navigate(page, "协作");
  await expect(
    page.locator(".workspace-card").filter({ hasText: "设计协作组" }),
  ).toBeVisible();
  await capture(page, "20-collaboration", "协作、工作区与邀请");
  await page.getByRole("button", { name: "创建工作区", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("用户体验小组");
  await capture(page, "21-workspace-create", "创建工作区");
  await close(page);
  await page
    .locator(".workspace-card")
    .filter({ hasText: "设计协作组" })
    .click();
  await expect(page.getByLabel("角色 陈安", { exact: true })).toBeVisible();
  await capture(page, "22-workspace-members", "成员、角色与邀请成员");
  await page.getByLabel("角色 陈安", { exact: true }).selectOption("viewer");
  await expect(page.getByLabel("角色 陈安", { exact: true })).toHaveValue(
    "viewer",
  );
  await capture(page, "23-workspace-readonly", "设置只读成员");
  await page.getByRole("button", { name: "移除", exact: true }).click();
  await capture(page, "24-workspace-remove", "移除成员确认");
  await close(page);
  const openedChat = app.waitForEvent("window");
  await page.locator(".contact-button").filter({ hasText: "陈安" }).click();
  const chat = await openedChat;
  await expect(chat.locator(".chat-message")).toHaveCount(2);
  await capture(chat, "25-chat", "独立好友聊天窗口");
  await chat.getByRole("button", { name: "关闭聊天窗口", exact: true }).click();
  await navigate(page, "通知中心");
  await capture(page, "26-notifications", "通知中心");
  await navigate(page, "设置");
  await capture(page, "27-settings", "外观、隐私与同步设置");
  await page.getByRole("button", { name: "修改昵称", exact: true }).click();
  await capture(page, "46-profile-name", "修改账号昵称");
  await close(page);
  await page
    .locator(".page")
    .evaluate((node) => (node.scrollTop = node.scrollHeight));
  await capture(page, "28-settings-data", "数据、加密备份与更新状态");
  await page.getByRole("button", { name: "创建备份", exact: true }).click();
  await capture(page, "29-backup", "创建口令加密备份");
  await close(page);
  await page.getByRole("button", { name: "从备份恢复", exact: true }).click();
  await capture(page, "30-restore", "恢复口令加密备份");
  await close(page);
  await invoke(page, "sync.pause", { paused: true });
  await navigate(page, "我的任务");
  await capture(page, "31-offline", "离线工作状态");
  const task = (await invoke(page, "tasks.list")).find(
    (t: any) => t.body.title === "完成产品需求文档",
  );
  const otherDevice = new Network(
    peer.base,
    { current: null, revocations: [] },
    async () => {},
  );
  await otherDevice.login("login", {
    identifier: user.email,
    password: "correct horse battery",
  });
  const remote = (await otherDevice.request<any[]>("/tasks")).find(
    (t) => t.id === task.id,
  );
  await otherDevice.request("/sync/push", "POST", {
    operations: [
      {
        operation_id: randomUUID(),
        entity_id: task.id,
        entity_type: "task",
        workspace_id: null,
        action: "upsert",
        base_version: remote.version,
        payload: { ...remote.body, title: "服务器调整后的需求范围" },
      },
    ],
  });
  await invoke(page, "tasks.save", {
    id: task.id,
    workspace_id: null,
    body: { ...task.body, title: "本机补充后的需求范围" },
  });
  await invoke(page, "sync.pause", { paused: false });
  await invoke(page, "sync.run");
  await expect
    .poll(() => invoke(page, "sync.status").then((s) => s.conflicts), {
      timeout: 30000,
    })
    .toBe(1);
  await page.getByRole("button", { name: /有冲突待处理/ }).click();
  await capture(page, "32-conflict", "真实的双设备版本冲突");
  await page
    .getByRole("button", { name: "保留这台设备上的版本", exact: true })
    .click();
  await sync(page);
  await capture(page, "33-conflict-resolved", "冲突处理完成");
  execFileSync(
    python,
    [
      "-c",
      "import sqlite3,os,sys; c=sqlite3.connect(os.environ['TASKLINK_DATABASE_URL'].removeprefix('sqlite:///')); c.execute('UPDATE auth_sessions SET access_expires=0,refresh_expires=0 WHERE user_id=?',(sys.argv[1],)); c.commit(); c.close()",
      user.id,
    ],
    { env: serverEnv, windowsHide: true },
  );
  await invoke(page, "sync.run");
  await expect
    .poll(() => invoke(page, "sync.status").then((s) => s.state), {
      timeout: 30000,
    })
    .toBe("auth_required");
  await page.getByRole("button", { name: "重新登录", exact: true }).click();
  await capture(page, "34-reauth", "会话过期后的重新登录");
  await page
    .getByRole("dialog")
    .getByLabel("账号 / 邮箱", { exact: true })
    .fill(user.email);
  await page
    .getByRole("dialog")
    .getByLabel("密码", { exact: true })
    .fill("correct horse battery");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "登录", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15000 });
  await sync(page);
  await invoke(page, "settings.set", {
    theme: "dark",
    notifications: false,
    notificationPreview: false,
    closeToTray: true,
  });
  await navigate(page, "我的任务");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await capture(page, "35-dark-tasks", "深色主题任务列表");
  await navigate(page, "日历");
  await capture(page, "36-dark-calendar", "深色主题日历");
  await navigate(page, "我的任务");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(980, 700),
  );
  expect(
    await page
      .locator(".page")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await capture(page, "37-compact", "最小窗口布局");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1380, 860),
  );
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await capture(page, "38-logout", "退出登录确认");
  await close(page);
}
