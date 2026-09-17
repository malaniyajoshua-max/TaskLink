import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

async function invoke(page: Page, command: string, input: unknown = {}) {
  return page.evaluate(
    ([command, input]) => (window as any).tasklink.invoke(command, input),
    [command, input],
  );
}
async function openChat(app: ElectronApplication, page: Page, name: string) {
  const [chat] = await Promise.all([
    app.waitForEvent("window"),
    page.getByRole("button", { name: "聊天", exact: true }).click(),
  ]);
  await chat
    .getByRole("button", { name: `与${name}聊天`, exact: true })
    .click();
  await expect(chat.getByLabel("消息内容", { exact: true })).toBeEnabled();
  return chat;
}
async function pick(app: ElectronApplication, files: string[]) {
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: files,
    })) as any;
  }, files);
}
async function dropFiles(
  page: Page,
  files: string[],
  capture?: () => Promise<void>,
) {
  // Disk-backed File objects traverse the actual sandboxed preload bridge.
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "test-native-files";
    document.body.appendChild(input);
  });
  await page.locator("#test-native-files").setInputFiles(files);
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    for (const file of Array.from(
      (document.querySelector("#test-native-files") as HTMLInputElement).files!,
    ))
      data.items.add(file);
    return data;
  });
  await page
    .locator(".chat-conversation")
    .dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(page.getByLabel("拖放上传区域")).toBeVisible();
  if (capture) await capture();
  await page
    .locator(".chat-conversation")
    .dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  await page.locator("#test-native-files").evaluate((node) => node.remove());
}
async function send(page: Page, text: string) {
  await page.getByLabel("消息内容", { exact: true }).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByLabel("消息内容", { exact: true })).toHaveValue("");
}

export async function chatAcceptance(
  launch: (profile: string) => Promise<ElectronApplication>,
  directory: string,
  register: (page: Page, name: string, email: string) => Promise<void>,
) {
  const artifacts =
    process.env.TASKLINK_CHAT_GALLERY_DIR ??
    path.join(directory, "chat-review");
  mkdirSync(artifacts, { recursive: true });
  const fixture = path.join(directory, "湖畔灵感.png"),
    notes = path.join(directory, "项目资料.txt"),
    avatar = path.join(directory, "avatar.png");
  // Deterministic original test artwork, encoded as real PNG; never seeded into the application.
  const landscape = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#a8daec"/><stop offset="1" stop-color="#f4ecd3"/></linearGradient><linearGradient id="lake" x2="0" y2="1"><stop stop-color="#80c8c1"/><stop offset="1" stop-color="#327d99"/></linearGradient></defs><rect width="800" height="450" fill="url(#sky)"/><circle cx="630" cy="100" r="42" fill="#fff4ce"/><path d="M0 280 180 90 300 230 470 60 680 270 800 180V450H0" fill="#779dab"/><path d="m180 90 53 74-43-11-23 24-21-18zM470 60l73 108-49-22-30 16-23-36-41 5z" fill="#f1f4ec"/><path d="M0 310 125 224 235 306 360 206 580 330 750 205 800 244V450H0" fill="#316e7a"/><path d="M0 336Q170 298 320 336T800 310V450H0" fill="url(#lake)"/><path d="M210 386q150-18 300 0M125 417q160-18 330 0" stroke="#b6e0d5" stroke-width="3" fill="none" opacity=".6"/></svg>`;
  writeFileSync(fixture, new Resvg(landscape).render().asPng());
  writeFileSync(
    avatar,
    new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#dedcf9"/><circle cx="64" cy="50" r="26" fill="#f1c5a5"/><path d="M18 128q0-52 46-52t46 52" fill="#535ed2"/><path d="M38 47q-7-38 29-35 33 0 26 43-8-6-12-24-17 16-43 16" fill="#273c58"/></svg>`,
    )
      .render()
      .asPng(),
  );
  writeFileSync(notes, "TaskLink 私有附件验收资料\n".repeat(18000));
  const screenshots: string[] = [],
    errors: string[] = [];
  const capture = async (page: Page, name: string) => {
    await page.bringToFront();
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: path.join(artifacts, name + ".png"),
      scale: "css",
      animations: "disabled",
    });
    screenshots.push(name + ".png");
  };
  let a = await launch("chat-rich-a");
  const b = await launch("chat-rich-b");
  let pa = await a.firstWindow(),
    ca: Page;
  const pb = await b.firstWindow();
  try {
    await register(pa, "周予安", "chat-a@example.com");
    await register(pb, "林然", "chat-b@example.com");
    const alice = await invoke(pa, "auth.status"),
      bob = await invoke(pb, "auth.status");
    const request = await invoke(pa, "friends.add", { email: bob.email });
    await invoke(pb, "friends.decide", { id: request.id, accept: true });
    await invoke(pa, "sync.run");
    await invoke(pb, "sync.run");
    const preferences = await invoke(pa, "settings.get");
    await invoke(pa, "settings.set", {
      ...preferences,
      theme: "light",
      notifications: false,
    });
    ca = await openChat(a, pa, bob.name);
    const cb = await openChat(b, pb, alice.name);
    ca.on("pageerror", (e) => errors.push(e.message));
    cb.on("pageerror", (e) => errors.push(e.message));
    expect(ca.url()).toContain("#chat");
    await expect(
      pa.getByRole("button", { name: "新建任务", exact: true }),
    ).toBeVisible();
    const windows = await a.evaluate(({ BrowserWindow, screen }) => {
      const main = BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.getURL().endsWith("#chat"),
      )!;
      const chat = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith("#chat"),
      )!;
      return {
        main: main.getBounds(),
        chat: chat.getBounds(),
        area: screen.getDisplayMatching(main.getBounds()).workArea,
        options: chat.webContents.getLastWebPreferences(),
        count: BrowserWindow.getAllWindows().length,
      };
    });
    expect(windows.count).toBe(2);
    expect(windows.options.sandbox).toBe(true);
    expect(windows.options.nodeIntegration).toBe(false);
    expect(windows.options.contextIsolation).toBe(true);
    const expectedX = Math.max(
      windows.area.x,
      Math.min(
        windows.main.x +
          Math.round((windows.main.width - windows.chat.width) / 2),
        windows.area.x + windows.area.width - windows.chat.width,
      ),
    );
    // Windows reports invisible resize borders differently at fractional DPI.
    expect(Math.abs(windows.chat.x - expectedX)).toBeLessThanOrEqual(8);
    const security = await ca.evaluate(async () => {
      const api = (window as any).tasklink;
      let denied = false,
        synthetic = false;
      try {
        await api.invoke("tasks.list", {});
      } catch {
        denied = true;
      }
      try {
        await api.stageFiles(
          [new File(["hello"], "fake.txt")],
          "00000000-0000-4000-8000-000000000001",
        );
      } catch {
        synthetic = true;
      }
      return {
        denied,
        synthetic,
        node: typeof (window as any).require,
        storage: Object.keys(localStorage),
      };
    });
    expect(security).toEqual({
      denied: true,
      synthetic: true,
      node: "undefined",
      storage: [],
    });
    await pick(b, [avatar]);
    await cb.getByRole("button", { name: "更换头像", exact: true }).click();
    await expect(cb.locator(".chat-self img")).toBeVisible();
    await invoke(pa, "sync.run");
    await expect(ca.locator(".chat-peer-heading img")).toBeVisible();
    await send(cb, "午后好！这次我们把想法和资料放在一起讨论吧。");
    await expect(
      ca
        .locator(".chat-bubble")
        .getByText("午后好！这次我们把想法和资料放在一起讨论吧。", {
          exact: true,
        }),
    ).toBeVisible();
    await ca
      .getByLabel("消息内容", { exact: true })
      .fill("好呀，我把参考图发给你。 ");
    await ca.getByRole("button", { name: "表情与表情包", exact: true }).click();
    await ca.getByRole("button", { name: "插入表情 😊", exact: true }).click();
    await ca.getByRole("button", { name: "关闭表情面板", exact: true }).click();
    await ca.getByRole("button", { name: "发送", exact: true }).click();
    await expect(cb.locator(".chat-bubble")).toContainText(["午后好", "😊"]);
    await dropFiles(ca, [fixture, notes], () => capture(ca, "04-drag-files"));
    await expect(ca.locator(".chat-pending-file")).toHaveCount(2);
    await capture(ca, "05-pending-files");
    await ca.getByRole("button", { name: "发送", exact: true }).click();
    await expect(ca.locator(".chat-pending-file")).toHaveCount(0);
    await expect(
      cb.getByRole("button", { name: "预览图片 湖畔灵感.png", exact: true }),
    ).toBeVisible();
    await cb.getByRole("button", { name: "表情与表情包", exact: true }).click();
    await cb.getByRole("button", { name: "表情包", exact: true }).click();
    await cb
      .getByRole("button", { name: "选择表情包 收到", exact: true })
      .click();
    await cb.getByRole("button", { name: "发送", exact: true }).click();
    await expect(ca.getByLabel("表情包：收到", { exact: true })).toBeVisible();
    await ca.locator(".chat-history").evaluate((node) => {
      node.scrollTop = 0;
    });
    await capture(ca, "01-chat-window");
    await ca.locator(".chat-history").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await ca.getByRole("button", { name: "表情与表情包", exact: true }).click();
    await capture(ca, "02-emoji");
    await ca.getByRole("button", { name: "表情包", exact: true }).click();
    await capture(ca, "03-stickers");
    await ca.getByRole("button", { name: "关闭表情面板", exact: true }).click();
    await ca
      .getByRole("button", { name: "预览图片 湖畔灵感.png", exact: true })
      .click();
    await expect(ca.getByRole("dialog")).toBeVisible();
    await capture(ca, "06-image-preview");
    await ca.getByRole("button", { name: "关闭对话框", exact: true }).click();
    const destination = path.join(directory, "downloaded-notes.txt");
    await b.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: file,
      })) as any;
    }, destination);
    await cb
      .getByRole("button", { name: "另存为 项目资料.txt", exact: true })
      .click();
    await expect(
      cb.getByRole("status").filter({ hasText: "已保存" }),
    ).toBeVisible();
    expect(readFileSync(destination)).toEqual(readFileSync(notes));
    await pick(a, [fixture]);
    await ca.getByRole("button", { name: "选择图片", exact: true }).click();
    await expect(ca.locator(".chat-pending-file")).toHaveCount(1);
    await ca
      .getByRole("button", { name: "移除附件 湖畔灵感.png", exact: true })
      .click();
    await expect(ca.locator(".chat-pending-file")).toHaveCount(0);
    const forbidden = path.join(directory, "blocked.exe");
    writeFileSync(forbidden, "MZ");
    await pick(a, [forbidden]);
    await ca.getByRole("button", { name: "添加文件", exact: true }).click();
    await expect(ca.getByRole("alert")).toContainText("类型");
    await pick(a, [notes]);
    await ca.getByRole("button", { name: "添加文件", exact: true }).click();
    await expect(ca.locator(".chat-pending-file")).toHaveCount(1);
    await invoke(pa, "sync.pause", { paused: true });
    await ca
      .getByLabel("消息内容", { exact: true })
      .fill("离线保留的草稿，下次打开继续发送。");
    await ca.getByRole("button", { name: "发送", exact: true }).click();
    await expect(ca.getByRole("alert")).toContainText("草稿已保留");
    await capture(ca, "09-offline-draft");
    const savedId = (await invoke(ca, "chat.draft", { peer_id: bob.id })).id;
    await a.close();
    a = await launch("chat-rich-a");
    pa = await a.firstWindow();
    ca = await openChat(a, pa, bob.name);
    ca.on("pageerror", (e) => errors.push(e.message));
    await expect(ca.getByLabel("消息内容", { exact: true })).toHaveValue(
      "离线保留的草稿，下次打开继续发送。",
    );
    await expect(ca.locator(".chat-pending-file")).toHaveCount(1);
    expect((await invoke(ca, "chat.draft", { peer_id: bob.id })).id).toBe(
      savedId,
    );
    await invoke(pa, "sync.pause", { paused: false });
    await ca.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      cb
        .locator(".chat-bubble")
        .getByText("离线保留的草稿，下次打开继续发送。", { exact: true }),
    ).toBeVisible();
    await invoke(pa, "settings.set", {
      ...preferences,
      theme: "dark",
      notifications: false,
    });
    await expect(ca.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(ca, "07-dark-chat");
    await invoke(pa, "settings.set", {
      ...preferences,
      theme: "light",
      notifications: false,
    });
    await expect(ca.locator("html")).toHaveAttribute("data-theme", "light");
    await a.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("#chat"))!
        .setContentSize(860, 620),
    );
    await expect(
      ca.getByRole("button", { name: "发送", exact: true }),
    ).toBeVisible();
    expect(
      await ca.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await capture(ca, "08-compact-chat");
    await invoke(pa, "chat.open", { peer_id: bob.id });
    expect(a.windows()).toHaveLength(2);
    // Revocation is server enforced, and cached history becomes read-only.
    await invoke(pb, "friends.remove", { id: request.id });
    await invoke(pa, "sync.run");
    await expect(ca.getByLabel("消息内容", { exact: true })).toBeDisabled();
    await invoke(pa, "auth.logout");
    await expect.poll(() => a.windows().length).toBe(1);
    expect(errors).toEqual([]);
    writeFileSync(
      path.join(artifacts, "index.json"),
      JSON.stringify(
        {
          screenshots,
          rendererErrors: errors,
          assertions: [
            "real dual users",
            "centered independent sandbox window",
            "avatar sync",
            "text and emoji",
            "stickers",
            "real-file drag/drop",
            "PNG preview",
            "native save and exact bytes",
            "unsafe type and synthetic File rejection",
            "encrypted draft and attachment restart",
            "reconnection",
            "dark and compact layouts",
            "revocation",
            "logout closes chat",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await a.close();
    await b.close();
  }
}
