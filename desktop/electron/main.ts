import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  session,
  Tray,
  screen,
  type IpcMainInvokeEvent,
} from "electron";
import { Worker } from "node:worker_threads";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { autoUpdater } from "electron-updater";
import {
  commands,
  type Command,
  type Result,
  type UpdateStatus,
  type Vault,
  userSchema,
  type Friend,
  type Attachment,
} from "../shared/contract";
import {
  FILE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  safeFileName,
} from "../shared/chat";
import { protect, unprotect, isCurrentProtection } from "./os-storage";
import { AppError, safeError } from "./errors";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "tasklink",
    privileges: { secure: true, standard: true, supportFetchAPI: true },
  },
]);
if (process.env.TASKLINK_USER_DATA)
  app.setPath("userData", path.resolve(process.env.TASKLINK_USER_DATA));
if (!app.requestSingleInstanceLock()) app.exit(0);
const directory = app.getPath("userData");
mkdirSync(directory, { recursive: true });
const vaultFile = path.join(directory, "credentials.bin");
const devUrl = !app.isPackaged ? process.env.TASKLINK_DEV_URL : undefined;
if (devUrl && new URL(devUrl).origin !== "http://127.0.0.1:5173")
  throw new Error("Invalid development origin");
let win: BrowserWindow | null = null;
let chatWin: BrowserWindow | null = null;
let chatPeer: string | null = null;
let worker: Worker;
let workerFailure: AppError | null = null;
let tray: Tray;
let quitting = false;
let closeToTray = true;
const pending = new Map<
  string,
  {
    resolve: (r: Result) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const update: UpdateStatus = {
  version: app.getVersion(),
  state: "disabled",
  message: "未配置更新服务；可手动安装新版本",
};
async function readVault(): Promise<Vault> {
  if (!existsSync(vaultFile)) return { current: null, revocations: [] };
  const bytes = readFileSync(vaultFile);
  const plaintext = await unprotect(bytes);
  if (!isCurrentProtection(bytes)) await writeProtected(vaultFile, plaintext);
  return z
    .object({
      current: z
        .object({
          user: userSchema,
          access_token: z.string().min(32).max(200),
          refresh_token: z.string().min(32).max(200),
          expiresAt: z.number().finite(),
        })
        .nullable(),
      revocations: z.array(z.string().min(32).max(200)).max(1000),
    })
    .parse(JSON.parse(plaintext));
}
async function writeProtected(filename: string, value: string) {
  writeFileSync(filename + ".tmp", await protect(value), {
    mode: 0o600,
    flush: true,
  });
  renameSync(filename + ".tmp", filename);
}
async function writeVault(value: Vault) {
  await writeProtected(vaultFile, JSON.stringify(value));
}
async function storageKey(): Promise<Buffer> {
  const filename = path.join(directory, "storage-key.bin");
  if (existsSync(filename)) {
    const bytes = readFileSync(filename),
      plaintext = await unprotect(bytes);
    const key = Buffer.from(plaintext, "base64");
    if (key.length !== 32)
      throw new AppError("storage_key", "数据密钥文件损坏，请从安全备份恢复");
    if (!isCurrentProtection(bytes)) await writeProtected(filename, plaintext);
    return key;
  }
  const key = randomBytes(32);
  await writeProtected(filename, key.toString("base64"));
  return key;
}
function notifyChanged(dataChanged = true) {
  for (const window of [win, chatWin])
    if (window && !window.isDestroyed())
      window.webContents.send("tasklink:changed", dataChanged);
}
function rpc(command: string, input: unknown): Promise<Result> {
  if (workerFailure) return Promise.reject(workerFailure);
  if (pending.size >= 64)
    return Promise.reject(new AppError("busy", "数据进程繁忙，请稍后重试"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(new AppError("worker_timeout", "数据进程响应超时，请重试"));
      },
      command === "messages.send" || command === "file.chat-save"
        ? 600000
        : 120000,
    );
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, type: "request", command, input });
  });
}
function trustedWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const window = [win, chatWin].find(
    (candidate) =>
      candidate &&
      !candidate.isDestroyed() &&
      candidate.webContents === event.sender,
  );
  if (!window || event.senderFrame !== window.webContents.mainFrame)
    throw new AppError("forbidden_ipc", "拒绝不可信 IPC 来源");
  const url = new URL(event.senderFrame.url);
  if (
    devUrl
      ? url.origin !== devUrl
      : url.protocol !== "tasklink:" ||
        url.hostname !== "app" ||
        url.pathname !== "/index.html"
  )
    throw new AppError("forbidden_ipc", "拒绝不可信页面");
  return window;
}
function secureWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
}
async function openChat(peerId?: string): Promise<Result> {
  const auth = await rpc("auth.status", {});
  if (!auth.ok) return auth;
  if (!auth.value) throw new AppError("auth_required", "请先登录");
  if (peerId) {
    const friends = await rpc("friends.list", {});
    if (!friends.ok) return friends;
    if (
      !(friends.value as Friend[]).some(
        (f) => f.status === "accepted" && f.user.id === peerId,
      )
    )
      throw new AppError("friend_required", "请先确认好友关系");
    chatPeer = peerId;
  }
  if (chatWin && !chatWin.isDestroyed()) {
    if (chatWin.isMinimized()) chatWin.restore();
    chatWin.show();
    chatWin.focus();
    if (peerId) chatWin.webContents.send("tasklink:chat-peer", peerId);
    return { ok: true, value: null };
  }
  const bounds = win?.getBounds() ?? screen.getPrimaryDisplay().workArea;
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(1200, area.width),
    height = Math.min(830, area.height);
  const window = new BrowserWindow({
    width,
    height,
    minWidth: 860,
    minHeight: 620,
    x: Math.max(
      area.x,
      Math.min(
        bounds.x + Math.round((bounds.width - width) / 2),
        area.x + area.width - width,
      ),
    ),
    y: Math.max(
      area.y,
      Math.min(
        bounds.y + Math.round((bounds.height - height) / 2),
        area.y + area.height - height,
      ),
    ),
    title: "TaskLink · 聊天",
    icon: path.join(app.getAppPath(), "dist/icon.png"),
    show: false,
    backgroundColor: "#f4f7fc",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  chatWin = window;
  secureWindow(window);
  window.on("closed", () => {
    if (chatWin === window) {
      chatWin = null;
      chatPeer = null;
    }
  });
  window.once("ready-to-show", () => {
    window.setTitle("TaskLink · 聊天");
    window.show();
    window.focus();
  });
  await window.loadURL((devUrl ?? "tasklink://app/index.html") + "#chat");
  return { ok: true, value: null };
}
async function chatFileCommand(
  command: Command,
  input: Record<string, unknown>,
  owner: BrowserWindow,
): Promise<Result> {
  const avatar = command === "profile.avatar";
  if (!avatar && owner !== chatWin)
    throw new AppError("forbidden_ipc", "请在独立聊天窗口操作附件");
  if (command === "attachments.save") {
    const info = await rpc("attachments.info", input);
    if (!info.ok) return info;
    const file = info.value as Attachment;
    if (!safeFileName(file.name))
      throw new AppError("invalid_file", "服务端返回的文件名无效");
    const result = await dialog.showSaveDialog(owner, {
      title: "另存聊天附件（请勿打开不可信文件）",
      defaultPath: file.name,
      filters: [
        { name: "聊天附件", extensions: [file.name.split(".").at(-1)!] },
      ],
    });
    if (owner.isDestroyed() || owner !== chatWin)
      throw new AppError("window_closed", "聊天窗口已关闭，文件操作已取消");
    if (result.canceled || !result.filePath)
      return { ok: true, value: { canceled: true } };
    return rpc("file.chat-save", { id: input.id, path: result.filePath });
  }
  const result = await dialog.showOpenDialog(owner, {
    title: avatar
      ? "选择头像（不超过 5 MB）"
      : "选择待发送附件（每个不超过 25 MB）",
    properties: avatar ? ["openFile"] : ["openFile", "multiSelections"],
    filters: [
      {
        name: avatar || input.images_only ? "图片 / GIF" : "支持的文件",
        extensions:
          avatar || input.images_only ? IMAGE_EXTENSIONS : FILE_EXTENSIONS,
      },
    ],
  });
  if (
    owner.isDestroyed() ||
    (avatar ? owner !== win && owner !== chatWin : owner !== chatWin)
  )
    throw new AppError("window_closed", "窗口已关闭，文件操作已取消");
  if (result.canceled)
    return { ok: true, value: avatar ? { canceled: true } : [] };
  if (result.filePaths.length > 5)
    throw new AppError("too_many_files", "每次最多选择 5 个文件");
  return avatar
    ? rpc("file.chat-avatar", { path: result.filePaths[0] })
    : rpc("file.chat-stage", {
        paths: result.filePaths,
        peer_id: input.peer_id,
      });
}
async function fileCommand(
  command: Command,
  input: { passphrase?: string } = {},
) {
  if (!win) throw new AppError("window_closed", "窗口已关闭");
  if (command === "data.import" || command === "data.restore") {
    const result = await dialog.showOpenDialog(win, {
      title:
        command === "data.import" ? "导入 TaskLink 数据" : "从加密备份恢复",
      properties: ["openFile"],
      filters: [
        {
          name:
            command === "data.import" ? "TaskLink 数据" : "TaskLink 加密备份",
          extensions:
            command === "data.import"
              ? ["json"]
              : input.passphrase
                ? ["tlbackup"]
                : ["sqlite"],
        },
      ],
    });
    if (result.canceled)
      return { ok: true, value: { canceled: true } } as Result;
    if (command === "data.restore") {
      const choice = await dialog.showMessageBox(win, {
        type: "warning",
        buttons: ["取消", "确认恢复"],
        defaultId: 0,
        cancelId: 0,
        message: "恢复会替换当前账号在这台电脑上的数据。",
        detail:
          "开始前会自动创建保护副本。只能恢复由当前账号创建的 TaskLink 备份。",
      });
      if (choice.response !== 1)
        return { ok: true, value: { canceled: true } } as Result;
    }
    return rpc(command === "data.import" ? "file.import" : "file.restore", {
      path: result.filePaths[0],
      passphrase: input.passphrase,
    });
  }
  const isBackup = command === "data.backup";
  if (!isBackup) {
    const choice = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["取消", "继续导出"],
      defaultId: 0,
      cancelId: 0,
      message: "导出的数据文件没有加密保护。",
      detail:
        "任何获得文件的人都能读取其中的任务和项目。请妥善保存；需要完整迁移时，请使用加密备份。",
    });
    if (choice.response !== 1)
      return { ok: true, value: { canceled: true } } as Result;
  }
  const result = await dialog.showSaveDialog(win, {
    title: isBackup ? "创建 TaskLink 加密备份" : "导出 TaskLink 数据",
    defaultPath:
      "TaskLink-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      (isBackup ? (input.passphrase ? ".tlbackup" : ".sqlite") : ".json"),
    filters: [
      {
        name: isBackup ? "TaskLink 加密备份" : "TaskLink 数据",
        extensions: [
          isBackup ? (input.passphrase ? "tlbackup" : "sqlite") : "json",
        ],
      },
    ],
  });
  if (result.canceled || !result.filePath)
    return { ok: true, value: { canceled: true } } as Result;
  return rpc(isBackup ? "file.backup" : "file.export", {
    path: result.filePath,
    passphrase: input.passphrase,
  });
}
function setupUpdates() {
  autoUpdater.logger = null;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  const packagedConfig = app.isPackaged
    ? JSON.parse(
        readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"),
      ).tasklinkUpdate
    : undefined;
  const url = packagedConfig?.url;
  if (!url || !packagedConfig?.publisher) return;
  autoUpdater.allowDowngrade = false;
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(packagedConfig.channel)
  )
    throw new AppError(
      "insecure_update",
      "更新服务必须使用不含凭证的 HTTPS 地址",
    );
  autoUpdater.setFeedURL({
    provider: "generic",
    url,
    channel: packagedConfig.channel,
  });
  update.state = "idle";
  update.message = "已配置 HTTPS 更新渠道";
  autoUpdater.on("update-available", () => {
    update.state = "available";
    update.message = "发现新版本，点击下载更新";
    notifyChanged();
  });
  autoUpdater.on("update-not-available", () => {
    update.state = "idle";
    update.message = "当前已是最新版本";
    notifyChanged();
  });
  autoUpdater.on("update-downloaded", () => {
    update.state = "downloaded";
    update.message = "更新已下载，重启后安装";
    notifyChanged();
  });
  autoUpdater.on("error", () => {
    update.state = "error";
    update.message = "无法检查或下载更新，当前版本仍可使用";
    notifyChanged();
  });
}
async function updateCommand(command: Command): Promise<Result> {
  if (command === "updates.status") return { ok: true, value: update };
  if (command === "updates.install") {
    if (update.state !== "downloaded")
      throw new AppError("update_not_ready", "尚未下载更新");
    quitting = true;
    autoUpdater.quitAndInstall();
    return { ok: true, value: null };
  }
  if (update.state === "disabled") return { ok: true, value: update };
  if (update.state === "available") {
    await autoUpdater.downloadUpdate();
    return { ok: true, value: update };
  }
  update.state = "checking";
  update.message = "正在检查更新";
  notifyChanged();
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    update.state = "error";
    update.message = "更新服务不可用";
  }
  return { ok: true, value: update };
}
async function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 980,
    minHeight: 700,
    title: "TaskLink",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  secureWindow(win);
  win.on("close", (event) => {
    if (!quitting && closeToTray) {
      event.preventDefault();
      win?.hide();
    }
  });
  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => {
    win = null;
    chatWin?.destroy();
    if (!quitting) app.quit();
  });
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadURL("tasklink://app/index.html");
}
app
  .whenReady()
  .then(async () => {
    app.setAppUserModelId("com.tasklink.desktop");
    const dist = path.join(app.getAppPath(), "dist");
    protocol.handle("tasklink", async (request) => {
      const url = new URL(request.url);
      const filename = path.resolve(
        dist,
        "." + decodeURIComponent(url.pathname),
      );
      if (url.host !== "app" || !filename.startsWith(dist + path.sep))
        return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(filename).toString());
    });
    session.defaultSession.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on("will-download", (event) =>
      event.preventDefault(),
    );
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      let nonce = "";
      for (const key of Object.keys(headers))
        if (key.toLowerCase() === "content-security-policy") {
          if (devUrl && details.url.startsWith(devUrl + "/"))
            nonce =
              String(headers[key]).match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1] ??
              "";
          delete headers[key];
        }
      const csp =
        "default-src 'self'; script-src 'self'" +
        (nonce ? " 'nonce-" + nonce + "'" : "") +
        "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src " +
        (devUrl ? "'self' ws://127.0.0.1:5173" : "'none'") +
        "; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
      callback({
        responseHeaders: { ...headers, "Content-Security-Policy": [csp] },
      });
    });
    worker = new Worker(path.join(__dirname, "worker.cjs"), {
      workerData: {
        storageKey: await storageKey(),
        directory,
        api: process.env.TASKLINK_API_URL ?? "http://127.0.0.1:8000/api/v1",
        vault: await readVault(),
      },
    });
    let ready!: () => void;
    let startupFailed!: (error: Error) => void;
    const workerReady = new Promise<void>((resolve, reject) => {
      ready = resolve;
      startupFailed = reject;
    });
    const startupTimer = setTimeout(
      () =>
        startupFailed(
          new AppError(
            "worker_startup",
            "本地数据库初始化超时；请保留数据目录并重启应用",
          ),
        ),
      120000,
    );
    worker.on("message", async (message) => {
      if (message.type === "ready") {
        clearTimeout(startupTimer);
        ready();
      } else if (message.type === "vault") {
        try {
          await writeVault(message.vault);
          worker.postMessage({
            id: message.id,
            type: "vault-result",
            ok: true,
          });
        } catch {
          worker.postMessage({
            id: message.id,
            type: "vault-result",
            ok: false,
          });
        }
      } else if (message.type === "changed") notifyChanged(message.dataChanged);
      else if (message.type === "transfer") {
        if (chatWin && !chatWin.isDestroyed())
          chatWin.webContents.send("tasklink:transfer", message.progress);
      } else if (message.type === "notification") {
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: message.note.title,
            body: message.note.body,
            silent: false,
          });
          notification.on("click", () => {
            if (!win || win.isDestroyed()) return;
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          });
          notification.show();
        }
      } else if (message.type === "result") {
        const item = pending.get(message.id);
        if (item) {
          clearTimeout(item.timer);
          pending.delete(message.id);
          item.resolve(message.result);
        }
      }
    });
    worker.on("error", () => {
      clearTimeout(startupTimer);
      workerFailure = new AppError(
        "worker_failed",
        "本地数据库无法打开或数据进程异常。请保留数据与密钥文件；不要覆盖原文件，可从加密备份恢复。",
      );
      startupFailed(workerFailure);
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(
          new AppError(
            "worker_failed",
            "数据进程异常，请重启应用；本地数据库保留",
          ),
        );
      }
      pending.clear();
    });
    await workerReady;
    ipcMain.handle(
      "tasklink:stage-files",
      async (event, paths: unknown, peer: unknown): Promise<Result> => {
        try {
          if (trustedWindow(event) !== chatWin)
            throw new AppError("forbidden_ipc", "请拖入聊天窗口");
          const input = z
            .object({
              paths: z.array(z.string().min(1).max(32767)).min(1).max(5),
              peer_id: z.uuid(),
            })
            .strict()
            .parse({ paths, peer_id: peer });
          return await rpc("file.chat-stage", input);
        } catch (error) {
          return { ok: false, error: safeError(error) };
        }
      },
    );
    ipcMain.handle(
      "tasklink:invoke",
      async (event, command: unknown, input: unknown): Promise<Result> => {
        try {
          const owner = trustedWindow(event);
          if (typeof command !== "string" || !Object.hasOwn(commands, command))
            throw new AppError("unknown_command", "未知操作");
          if (
            Buffer.byteLength(JSON.stringify(input) ?? "", "utf8") >
            256 * 1024
          )
            throw new AppError("invalid_input", "单次操作内容过大");
          const cmd = command as Command;
          const parsed = commands[cmd].safeParse(input);
          if (!parsed.success)
            throw new AppError("invalid_input", "输入字段不符合要求");
          if (
            owner === chatWin &&
            !(
              cmd.startsWith("chat.") ||
              cmd.startsWith("messages.") ||
              cmd.startsWith("attachments.") ||
              [
                "auth.status",
                "friends.list",
                "settings.get",
                "sync.run",
                "sync.status",
                "profile.avatar",
              ].includes(cmd)
            )
          )
            throw new AppError("forbidden_ipc", "聊天窗口不允许执行此操作");
          if (cmd === "chat.open")
            return await openChat(
              (parsed.data as { peer_id?: string }).peer_id,
            );
          if (cmd === "chat.context")
            return { ok: true, value: { peer_id: chatPeer } };
          if (cmd === "chat.close") {
            if (owner === chatWin)
              setImmediate(() => {
                if (!owner.isDestroyed()) owner.close();
              });
            return { ok: true, value: null };
          }
          if (cmd === "system.copyText") {
            clipboard.writeText((parsed.data as { text: string }).text);
            return { ok: true, value: null };
          }
          if (
            ["attachments.pick", "attachments.save", "profile.avatar"].includes(
              cmd,
            )
          )
            return await chatFileCommand(
              cmd,
              parsed.data as Record<string, unknown>,
              owner,
            );
          if (
            cmd === "auth.logout" ||
            cmd === "auth.login" ||
            cmd === "auth.register"
          ) {
            chatWin?.destroy();
            chatWin = null;
            chatPeer = null;
          }
          if (cmd.startsWith("updates.")) return updateCommand(cmd);
          if (cmd === "data.restore") {
            chatWin?.destroy();
            chatWin = null;
            chatPeer = null;
          }
          if (cmd.startsWith("data."))
            return fileCommand(cmd, parsed.data as { passphrase?: string });
          const result = await rpc(cmd, parsed.data);
          if (
            result.ok &&
            (cmd === "settings.get" ||
              cmd === "settings.set" ||
              cmd === "settings.patch")
          )
            closeToTray = (result.value as { closeToTray: boolean })
              .closeToTray;
          return result;
        } catch (error) {
          return { ok: false, error: safeError(error) };
        }
      },
    );
    setupUpdates();
    tray = new Tray(
      nativeImage.createFromPath(path.join(__dirname, "tray.png")),
    );
    tray.setToolTip("TaskLink");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 TaskLink", click: () => win?.show() },
        {
          label: "退出",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on("double-click", () => win?.show());
    await createWindow();
  })
  .catch((error) => {
    const diagnostic = {
      time: new Date().toISOString(),
      version: app.getVersion(),
      ...safeError(error),
    };
    try {
      writeFileSync(
        path.join(directory, "startup-error.json"),
        JSON.stringify(diagnostic, null, 2),
      );
    } catch {}
    dialog.showErrorBox("TaskLink 无法启动", diagnostic.message);
    app.exit(1);
  });
app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => {
  void worker?.terminate();
});
app.on("activate", () => win?.show());
app.on("second-instance", () => {
  if (win?.isMinimized()) win.restore();
  win?.show();
  win?.focus();
});
