import { parentPort, workerData } from "node:worker_threads";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  commands,
  preferencesSchema,
  userSchema,
  type Command,
  type Entity,
  type Message,
  type Note,
  type Result,
  type Vault,
} from "../shared/contract";
import { AppError, safeError } from "./errors";
import { accountKey } from "./storage-crypto";
import { LocalStore } from "./local-store";
import { Network } from "./network";
import { SyncEngine } from "./sync-engine";
import { portableBackup, portableRestore } from "./portable-backup";
import { backup, exportJson, importJson, restore } from "./data-tools";
import { ChatStore } from "./chat-store";
import { ChatTransfers } from "./chat-transfers";
import type { Inputs, ChatDraft, Friend } from "../shared/contract";
import {
  initialFocus,
  settleFocus,
  transitionFocus,
  focusCommandSchema,
  type FocusState,
} from "../shared/focus";

const config = workerData as {
  directory: string;
  api: string;
  vault: Vault;
  storageKey: Uint8Array;
};
const persistPending = new Map<
  string,
  { resolve: () => void; reject: (e: Error) => void }
>();
async function persist(vault: Vault) {
  const id = randomUUID();
  const result = new Promise<void>((resolve, reject) =>
    persistPending.set(id, { resolve, reject }),
  );
  parentPort!.postMessage({ type: "vault", id, vault });
  return result;
}
const network = new Network(config.api, config.vault, persist);
let local: LocalStore | null = null;
let engine: SyncEngine | null = null;
let chat: ChatStore | null = null;
let transfers: ChatTransfers | null = null;
function changed(dataChanged = true) {
  parentPort!.postMessage({ type: "changed", dataChanged });
}
function openAccount() {
  const user = network.vault.current?.user;
  if (!user) return;
  local = new LocalStore(
    path.join(config.directory, "accounts", user.id + ".sqlite"),
    user.id,
    accountKey(config.storageKey, user.id),
  );
  engine = new SyncEngine(local, network, changed);
  chat = new ChatStore(local);
  transfers = new ChatTransfers(
    chat,
    network,
    (progress) => parentPort!.postMessage({ type: "transfer", progress }),
    changed,
    () => !!engine && !engine.paused,
  );
  engine.schedule();
}
function requireLocal() {
  if (!local) throw new AppError("auth_required", "请先登录");
  return local;
}
openAccount();

async function remote(route: string, method = "GET", body?: unknown) {
  if (engine?.paused) throw new AppError("offline", "此操作需要网络连接");
  const result = await network.request(route, method, body);
  if (method !== "GET") engine?.schedule(0);
  return result;
}
async function dispatch(
  command: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (command === "auth.status") return network.vault.current?.user ?? null;
  if (command === "auth.registrationCode")
    return network.requestRegistrationCode(input);
  if (command === "auth.passwordForgot")
    return network.requestPasswordReset(input);
  if (command === "auth.passwordReset")
    return network.completePasswordReset(input);
  if (command === "auth.login" || command === "auth.register") {
    transfers?.cancelAll();
    await engine?.stop();
    try {
      const user = await network.login(
        command === "auth.login" ? "login" : "register",
        input,
      );
      local?.close();
      local = null;
      engine = null;
      openAccount();
      changed();
      return user;
    } catch (error) {
      if (local) {
        engine = new SyncEngine(local, network, changed);
        engine.schedule();
      }
      throw error;
    }
  }
  if (command === "auth.logout") {
    transfers?.cancelAll();
    await engine?.stop();
    await network.logout();
    local?.close();
    local = null;
    engine = null;
    chat = null;
    transfers = null;
    changed();
    return null;
  }
  const store = requireLocal();
  switch (command) {
    case "tasks.list":
      return store.entities("task");
    case "projects.list":
      return store.entities("project");
    case "tasks.batch": {
      const result = store.batchTasks(input);
      engine?.schedule(350);
      changed();
      return result;
    }
    case "tasks.status": {
      const result = store.setTaskStatus(input);
      if (result.previous !== result.task.body.status) {
        engine?.schedule(350);
        changed();
      }
      return result;
    }
    case "tasks.undoStatus": {
      const result = store.undoTaskStatus(input.id as string);
      engine?.schedule(350);
      changed();
      return result;
    }
    case "tasks.duplicate": {
      const result = store.duplicateTask(input.id as string);
      engine?.schedule(350);
      changed();
      return result;
    }
    case "tasks.save":
    case "projects.save": {
      const entity = store.save(
        command === "tasks.save" ? "task" : "project",
        input.body,
        input.workspace_id as string | null,
        input.id as string | undefined,
      );
      engine?.schedule(350);
      changed();
      return entity;
    }
    case "tasks.delete":
    case "projects.delete":
      store.remove(input.id as string);
      engine?.schedule(350);
      changed();
      return null;
    case "sync.status":
      return engine!.status();
    case "sync.run":
      void engine!.run(true);
      return engine!.status();
    case "sync.pause":
      engine!.paused = input.paused as boolean;
      store.setMeta("syncPaused", engine!.paused);
      if (!engine!.paused) engine!.schedule(0);
      changed();
      return engine!.status();
    case "sync.conflicts":
      return store.conflicts();
    case "sync.resolve":
      store.resolve(
        input.operation_id as string,
        input.choice as "server" | "local" | "copy",
      );
      engine?.schedule(0);
      changed();
      return null;
    case "settings.get":
      return store.preferences();
    case "settings.set":
    case "settings.patch":
      store.setMeta(
        "preferences",
        preferencesSchema.parse({ ...store.preferences(), ...input }),
      );
      changed();
      return store.preferences();
    case "focus.get": {
      // A timer can expire while the app is closed. Reconcile on reads as well
      // as commands, before returning the state to any renderer.
      const previous = store.meta<FocusState>("focus", initialFocus());
      const state = settleFocus(previous, Date.now());
      if (state !== previous) store.setMeta("focus", state);
      return state;
    }
    case "focus.command": {
      const state = transitionFocus(
        store.meta<FocusState>("focus", initialFocus()),
        focusCommandSchema.parse(input),
        Date.now(),
      );
      store.setMeta("focus", state);
      changed();
      return state;
    }
    case "notifications.list":
      return store.notifications();
    case "notifications.read": {
      const note =
        store.readLocalNote(input.id as string) ??
        ((await remote(
          "/notifications/" + input.id + "/read",
          "POST",
        )) as Note);
      if (!note.local) store.mirror("notification", note.id, note);
      changed();
      return note;
    }
    case "workspaces.list":
      return store.allMirror("workspace");
    case "workspaces.create":
      return remote("/workspaces", "POST", input);
    case "workspaces.rename":
      return remote("/workspaces/" + input.id, "PATCH", { name: input.name });
    case "workspaces.members": {
      const key = "members:" + input.id;
      try {
        const members = await remote("/workspaces/" + input.id + "/members");
        store.setMeta(key, members);
        return members;
      } catch (error) {
        if (
          error instanceof AppError &&
          ["offline", "network_unavailable"].includes(error.code)
        )
          return store.meta(key, []);
        throw error;
      }
    }
    case "workspaces.invite":
      return remote("/workspaces/" + input.id + "/invites", "POST", {
        email: input.email,
        role: input.role,
      });
    case "workspaces.role":
      return remote(
        "/workspaces/" + input.id + "/members/" + input.user_id,
        "PATCH",
        { role: input.role },
      );
    case "workspaces.remove":
      return remote(
        "/workspaces/" + input.id + "/members/" + input.user_id,
        "DELETE",
      );
    case "invitations.list":
      return remote("/invitations");
    case "invitations.decide":
      return remote("/invitations/" + input.id + "/decision", "POST", {
        accept: input.accept,
      });
    case "friends.list":
      return store.allMirror("friend");
    case "friends.add":
      return remote("/friends", "POST", input);
    case "friends.decide":
      return remote("/friends/" + input.id + "/decision", "POST", {
        accept: input.accept,
      });
    case "friends.remove":
      return remote("/friends/" + input.id, "DELETE");
    case "profile.update": {
      const user = userSchema.parse(await remote("/profile", "PATCH", input));
      await network.updateUser(user);
      changed();
      return user;
    }
    case "chat.conversations":
      return store.conversations();
    case "chat.activity":
      return { sending: transfers!.isSending(input.peer_id as string) };
    case "chat.draft":
      return chat!.draft(input.peer_id as string);
    case "chat.saveDraft":
      if (transfers!.isSending(input.peer_id as string))
        throw new AppError("transfer_busy", "此会话正在发送，请稍后编辑草稿");
      chat!.saveDraft(input.peer_id as string, input.draft as ChatDraft);
      return null;
    case "attachments.staged":
      return chat!.staged(input.peer_id as string);
    case "attachments.remove":
      await transfers!.remove(input.id as string);
      return null;
    case "attachments.info":
      return transfers!.info(input.id as string);
    case "attachments.preview":
      return transfers!.preview(input.id as string);
    case "file.chat-stage": {
      if (transfers!.isSending(input.peer_id as string))
        throw new AppError("transfer_busy", "此会话正在发送，请稍后添加附件");
      if (
        !store
          .allMirror<Friend>("friend")
          .some((f) => f.status === "accepted" && f.user.id === input.peer_id)
      )
        throw new AppError("friend_required", "请先添加并确认好友");
      const files = chat!.stage(
        input.paths as string[],
        input.peer_id as string,
      );
      changed();
      return files;
    }
    case "file.chat-save":
      return transfers!.save(input.id as string, input.path as string);
    case "file.chat-avatar":
      return transfers!.avatar(input.path as string);
    case "messages.list":
      return store.messages(
        input.peer_id as string,
        input.limit as number,
        input.before as { created_at: string; id: string } | undefined,
      );
    case "messages.send": {
      const result = await transfers!.send(input as Inputs["messages.send"]);
      engine?.schedule(0);
      return result;
    }
    case "file.export":
      exportJson(store, input.path as string);
      return { canceled: false };
    case "file.import": {
      const count = importJson(store, input.path as string);
      engine?.schedule();
      changed();
      return { canceled: false, count };
    }
    case "file.backup":
      await engine!.stop();
      try {
        if (input.passphrase)
          portableBackup(
            store,
            input.path as string,
            input.passphrase as string,
          );
        else backup(store, input.path as string);
      } finally {
        engine = new SyncEngine(store, network, changed);
        engine.schedule();
      }
      return { canceled: false };
    case "file.restore":
      await engine!.stop();
      try {
        backup(
          store,
          path.join(
            config.directory,
            "before-restore-" + Date.now() + ".sqlite",
          ),
        );
        if (input.passphrase)
          portableRestore(
            store,
            input.path as string,
            input.passphrase as string,
          );
        else restore(store, input.path as string);
      } finally {
        engine = new SyncEngine(store, network, changed);
        engine.schedule();
      }
      changed();
      return { canceled: false };
    default:
      throw new AppError("unknown_command", "不支持的操作");
  }
}
// Media I/O may await the network while the serial queue serves local data.
// Account/restore barriers cancel and drain media jobs before closing SQLite.
let requests: Promise<void> = Promise.resolve();
const mediaJobs = new Set<Promise<void>>();
const mediaCommands = new Set([
  "messages.send",
  "attachments.preview",
  "file.chat-save",
  "file.chat-avatar",
]);
const lifecycleCommands = new Set([
  "auth.logout",
  "auth.login",
  "auth.register",
  "file.restore",
]);
parentPort!.on(
  "message",
  (message: {
    id: string;
    type: string;
    command?: string;
    input?: unknown;
    ok?: boolean;
  }) => {
    if (message.type === "vault-result") {
      const pending = persistPending.get(message.id);
      persistPending.delete(message.id);
      if (message.ok) pending?.resolve();
      else pending?.reject(new AppError("secure_storage", "凭证安全保存失败"));
      return;
    }
    if (message.command === "attachments.cancel") {
      try {
        const input = commands["attachments.cancel"].parse(message.input);
        transfers?.cancel(input.id);
        parentPort!.postMessage({
          type: "result",
          id: message.id,
          result: { ok: true, value: null },
        });
      } catch (error) {
        parentPort!.postMessage({
          type: "result",
          id: message.id,
          result: { ok: false, error: safeError(error) },
        });
      }
      return;
    }
    // Lifecycle transitions must cancel network transfers before entering the
    // serialized queue, otherwise logout could wait for a full large upload.
    if (lifecycleCommands.has(message.command ?? "")) transfers?.cancelAll();
    requests = requests.then(async () => {
      try {
        const command = message.command!;
        const input = command.startsWith("file.")
          ? message.input
          : commands[command as Command].parse(message.input);
        const execute = async () => {
          try {
            const value = await dispatch(
              command,
              input as Record<string, unknown>,
            );
            parentPort!.postMessage({
              type: "result",
              id: message.id,
              result: { ok: true, value } satisfies Result,
            });
          } catch (error) {
            parentPort!.postMessage({
              type: "result",
              id: message.id,
              result: { ok: false, error: safeError(error) },
            });
          }
        };
        if (lifecycleCommands.has(command)) {
          transfers?.cancelAll();
          await Promise.allSettled([...mediaJobs]);
        }
        if (mediaCommands.has(command)) {
          if (mediaJobs.size >= 3)
            throw new AppError(
              "transfer_busy",
              "已有多个附件正在传输，请稍后重试",
            );
          const job = execute().finally(() => mediaJobs.delete(job));
          mediaJobs.add(job);
        } else await execute();
      } catch (error) {
        const result: Result = { ok: false, error: safeError(error) };
        parentPort!.postMessage({ type: "result", id: message.id, result });
      }
    });
  },
);
setInterval(() => {
  if (!local) return;
  const notes = local.dueReminders();
  if (notes.length) {
    if (local.preferences().notifications)
      for (const note of notes)
        parentPort!.postMessage({
          type: "notification",
          note: local.preferences().notificationPreview
            ? note
            : { ...note, body: "你有新的任务提醒，请打开 TaskLink 查看。" },
        });
    changed();
  }
}, 5000);
parentPort!.postMessage({ type: "ready" });
