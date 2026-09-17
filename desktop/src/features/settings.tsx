import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Camera,
  Copy,
  Download,
  HardDrive,
  Info,
  Palette,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Upload,
  UserRound,
} from "lucide-react";
import {
  invoke,
  message,
  useCommand,
  type Command,
  type Preferences,
  type Entity,
} from "../api";
import { priorityLabel, statusLabel } from "./task-presentation";
import {
  Avatar,
  Button,
  Empty,
  ErrorBox,
  Heading,
  Modal,
  PasswordInput,
} from "../components/ui";
import { ThemePicker } from "../components/theme-picker";
import { seasonalThemes } from "../../shared/themes";
export function Settings() {
  const query = useCommand("settings.get", {}),
    account = useCommand("auth.status", {}),
    status = useCommand("sync.status", {}),
    updates = useCommand("updates.status", {});
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const qc = useQueryClient();
  const [backupMode, setBackupMode] = useState<
    "data.backup" | "data.restore" | null
  >(null);
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  async function save(patch: Partial<Preferences>) {
    if (!query.data) return;
    try {
      await invoke("settings.patch", patch);
      await qc.invalidateQueries({ queryKey: ["settings.get"] });
    } catch (e) {
      setError(message(e));
    }
  }
  async function file(
    command: "data.export" | "data.import" | "data.backup" | "data.restore",
    password?: string,
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke(
        command,
        password ? { passphrase: password } : {},
      );
      if (!result.canceled) {
        const notices: Record<typeof command, string> = {
          "data.export": "数据已导出。",
          "data.import":
            "已导入 " +
            ("count" in result ? (result.count ?? 0) : 0) +
            " 项记录。",
          "data.backup": "加密备份已创建。",
          "data.restore": "数据已从备份恢复。",
        };
        setNotice(notices[command]);
      }
      await qc.invalidateQueries();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function update() {
    setBusy(true);
    try {
      await invoke("updates.check", {});
      await qc.invalidateQueries({ queryKey: ["updates.status"] });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function chooseAvatar() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke("profile.avatar", {});
      if (result.user) {
        qc.setQueryData(["auth.status", {}], result.user);
        setNotice("头像已更新。");
      }
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  async function saveName(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await invoke("profile.update", { name });
      qc.setQueryData(["auth.status", {}], user);
      setEditingName(false);
      setNotice("昵称已更新。");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <Heading
        title="设置"
        description="调整账号、外观、通知、同步和数据保护。"
      />
      <ErrorBox error={error || query.error || account.error} />
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      <section className="settings-section">
        <h3>
          <UserRound size={17} />
          账号
        </h3>
        {account.data && (
          <div className="profile-setting">
            <button
              type="button"
              className="profile-avatar-button"
              aria-label="更换头像"
              disabled={busy}
              onClick={chooseAvatar}
            >
              <Avatar user={account.data} size={58} />
              <span aria-hidden="true">
                <Camera size={14} />
              </span>
            </button>
            <span>
              <b>{account.data.name}</b>
              <small>点击头像可选择新的图片</small>
            </span>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setError("");
                setName(account.data!.name);
                setEditingName(true);
              }}
            >
              <Pencil size={15} />
              修改昵称
            </Button>
          </div>
        )}
        <div className="setting-row account-id-row">
          <span>
            <b>{account.data?.account_id ?? "—"}</b>
            <small>专属账号，可与绑定邮箱二选一登录</small>
          </span>
          <Button
            variant="secondary"
            disabled={!account.data?.account_id}
            onClick={async () => {
              if (!account.data?.account_id) return;
              try {
                await invoke("system.copyText", {
                  text: account.data.account_id,
                });
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              } catch (reason) {
                setError(message(reason));
              }
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? "已复制" : "复制账号"}
          </Button>
        </div>
        <div className="setting-row">
          <span>
            <b>{account.data?.email ?? "—"}</b>
            <small>绑定邮箱，也可用于登录和找回密码</small>
          </span>
        </div>
      </section>
      {editingName && (
        <Modal
          title="修改昵称"
          onClose={() => {
            if (!busy) setEditingName(false);
          }}
        >
          <form className="editor-form" onSubmit={saveName}>
            <ErrorBox error={error} />
            <label>
              新昵称
              <input
                autoFocus
                value={name}
                minLength={1}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <div className="dialog-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setEditingName(false)}
              >
                取消
              </Button>
              <Button disabled={busy || !name.trim()}>
                {busy ? "正在保存…" : "保存昵称"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      <section className="settings-section">
        <h3>
          <Palette size={17} />
          外观与提醒
        </h3>
        <label className="setting-row">
          <span>
            <b>主题</b>
            <small>四季日夜八套风格，也可使用经典主题或跟随系统。</small>
          </span>
          <select
            aria-label="界面主题"
            value={query.data?.theme ?? "system"}
            onChange={(e) =>
              save({ theme: e.target.value as Preferences["theme"] })
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
            <optgroup label="四季 · 日与夜">
              {seasonalThemes.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <ThemePicker
          value={query.data?.theme ?? "system"}
          onChange={(theme) => void save({ theme })}
        />
        <label className="setting-row">
          <span>
            <b>系统通知显示任务标题</b>
            <small>默认隐藏正文，避免在锁屏或共享屏幕时泄露工作内容。</small>
          </span>
          <input
            type="checkbox"
            checked={query.data?.notificationPreview ?? false}
            onChange={(event) =>
              save({ notificationPreview: event.target.checked })
            }
          />
        </label>
        <label className="setting-row">
          <span>
            <b>系统通知</b>
            <small>到达任务的提醒时间后弹出，同时保留软件内的通知记录。</small>
          </span>
          <input
            type="checkbox"
            checked={query.data?.notifications ?? true}
            onChange={(e) => save({ notifications: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>
            <b>关闭窗口后驻留托盘</b>
            <small>关闭主窗口后继续接收提醒；可从托盘菜单完全退出。</small>
          </span>
          <input
            type="checkbox"
            checked={query.data?.closeToTray ?? true}
            onChange={(e) => save({ closeToTray: e.target.checked })}
          />
        </label>
        <p className="muted">
          提醒约每 5 秒检查一次，声音由 Windows
          通知设置控制，暂不支持自定义音乐。
          软件完全退出、电脑睡眠或关机时不会准时提醒；重新运行后补发尚未提醒的到期任务。
          仅设置截止时间不会触发提醒。
        </p>
      </section>
      <section className="settings-section">
        <h3>
          <RefreshCw size={17} />
          同步
        </h3>
        <div className="setting-row">
          <span>
            <b>
              {status.data?.conflicts
                ? `${status.data.conflicts} 项更改需要确认`
                : status.data?.pending
                  ? `${status.data.pending} 项更改等待同步`
                  : status.data?.paused
                    ? "同步已暂停"
                    : "所有更改已同步"}
            </b>
            <small>
              上次成功：
              {status.data?.lastSynced
                ? new Date(status.data.lastSynced).toLocaleString()
                : "尚未同步"}
            </small>
          </span>
          <Button
            variant="secondary"
            onClick={async () => {
              await invoke("sync.pause", { paused: !status.data?.paused });
              await qc.invalidateQueries();
            }}
          >
            {status.data?.paused ? "恢复同步" : "暂停同步"}
          </Button>
        </div>
      </section>
      <section className="settings-section">
        <h3>
          <ShieldCheck size={17} />
          数据保护
        </h3>
        <p className="muted">
          导出文件适合交换任务和项目，不包含登录凭证；导入时会创建新记录，不会覆盖现有内容。
        </p>
        <div className="button-group">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => file("data.export")}
          >
            <Download size={16} />
            导出数据
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => file("data.import")}
          >
            <Upload size={16} />
            导入数据
          </Button>
        </div>
        <div className="setting-row">
          <span>
            <b>完整加密备份</b>
            <small>
              包含任务、项目和等待同步的更改，可在另一台电脑上登录同一账号后恢复。
            </small>
          </span>
        </div>
        <div className="button-group">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setPassphrase("");
              setRepeat("");
              setBackupMode("data.backup");
            }}
          >
            <HardDrive size={16} />
            创建备份
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setPassphrase("");
              setRepeat("");
              setBackupMode("data.restore");
            }}
          >
            从备份恢复
          </Button>
        </div>
        <details className="security-details">
          <summary>查看安全说明</summary>
          <p>
            备份使用 AES-256-GCM
            加密，且不包含登录凭证。口令无法找回，请与备份文件分开保存。
          </p>
        </details>
      </section>
      {backupMode && (
        <Modal
          title={backupMode === "data.backup" ? "创建加密备份" : "恢复加密备份"}
          onClose={() => {
            if (!busy) {
              setBackupMode(null);
              setPassphrase("");
              setRepeat("");
            }
          }}
        >
          <form
            className="editor-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (backupMode === "data.backup" && passphrase !== repeat) return;
              const mode = backupMode,
                password = passphrase;
              setBackupMode(null);
              setPassphrase("");
              setRepeat("");
              await file(mode, password);
            }}
          >
            <p className="muted">
              设置至少 12
              个字符的备份口令。恢复时必须输入同一口令，且只能恢复到原账号。
            </p>
            <label className="field">
              备份口令
              <PasswordInput
                aria-label="备份口令"
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                required
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
            {backupMode === "data.backup" && (
              <label className="field">
                确认口令
                <PasswordInput
                  aria-label="确认口令"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={256}
                  required
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                />
              </label>
            )}
            {repeat && repeat !== passphrase && (
              <ErrorBox error="两次输入的口令不一致" />
            )}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setBackupMode(null);
                  setPassphrase("");
                  setRepeat("");
                }}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  busy ||
                  passphrase.length < 12 ||
                  (backupMode === "data.backup" && passphrase !== repeat)
                }
              >
                选择文件
              </Button>
            </div>
          </form>
        </Modal>
      )}
      <section className="settings-section">
        <h3>
          <Info size={17} />
          关于 TaskLink · {updates.data?.version}
        </h3>
        <p className="muted">{updates.data?.message}</p>
        <Button
          variant="secondary"
          disabled={
            busy ||
            updates.data?.state === "disabled" ||
            updates.data?.state === "checking"
          }
          onClick={
            updates.data?.state === "downloaded"
              ? () => invoke("updates.install", {})
              : update
          }
        >
          <RefreshCw size={16} />
          {updates.data?.state === "downloaded"
            ? "重启安装"
            : updates.data?.state === "available"
              ? "下载更新"
              : "检查更新"}
        </Button>
      </section>
    </section>
  );
}
export function Conflicts() {
  const query = useCommand("sync.conflicts", {});
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  async function resolve(
    operation_id: string,
    choice: "server" | "local" | "copy",
  ) {
    setBusy(true);
    try {
      await invoke("sync.resolve", { operation_id, choice });
      await qc.invalidateQueries();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <Heading
        title="同步冲突"
        description="同一内容在不同设备上都被修改时，请选择需要保留的版本。"
      />
      <ErrorBox error={error || query.error} />
      {!query.data?.length ? (
        <Empty title="没有待处理冲突" />
      ) : (
        query.data.map((item) => (
          <article key={item.operation_id} className="settings-section">
            <h3>
              {"title" in item.local.body
                ? item.local.body.title
                : item.local.body.name}
            </h3>
            <p className="muted">{item.message}</p>
            <div className="conflict-comparison">
              <div>
                <b>这台设备上的版本</b>
                <ConflictDetails entity={item.local} other={item.remote} />
              </div>
              <div>
                <b>云端版本 {item.remote?.version}</b>
                <ConflictDetails entity={item.remote} other={item.local} />
              </div>
            </div>
            <div className="button-group">
              <Button
                disabled={busy}
                variant="secondary"
                onClick={() => resolve(item.operation_id, "server")}
              >
                采用云端版本
              </Button>
              {item.remote && !item.remote.deleted && (
                <Button
                  disabled={busy}
                  onClick={() => resolve(item.operation_id, "local")}
                >
                  保留这台设备上的版本
                </Button>
              )}
              <Button
                disabled={busy}
                variant="secondary"
                onClick={() => resolve(item.operation_id, "copy")}
              >
                另存为个人记录
              </Button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}

function ConflictDetails({
  entity,
  other,
}: {
  entity: Entity | null;
  other: Entity | null;
}) {
  if (!entity || entity.deleted)
    return (
      <div className="conflict-details muted">
        {entity?.deleted ? "此记录已删除" : "记录不可用或访问权限已撤销"}
      </div>
    );
  const body = entity.body as unknown as Record<string, unknown>;
  const counterpart = (other?.body ?? {}) as unknown as Record<string, unknown>;
  const fields =
    entity.kind === "task"
      ? [
          ["title", "标题"],
          ["description", "描述"],
          ["status", "状态"],
          ["priority", "优先级"],
          ["start_at", "开始时间"],
          ["due_at", "截止时间"],
          ["reminder_at", "提醒时间"],
        ]
      : [
          ["name", "名称"],
          ["description", "描述"],
          ["archived", "归档状态"],
        ];
  function display(key: string, value: unknown) {
    if (value === null || value === undefined || value === "") return "未设置";
    if (key === "status")
      return statusLabel[value as keyof typeof statusLabel] ?? String(value);
    if (key === "priority")
      return (
        priorityLabel[value as keyof typeof priorityLabel] ?? String(value)
      );
    if (key === "archived") return value ? "已归档" : "未归档";
    if (key.endsWith("_at")) return new Date(String(value)).toLocaleString();
    return String(value);
  }
  return (
    <div className="conflict-details">
      <dl>
        {fields.map(([key, label]) => (
          <div
            key={key}
            className={
              body[key] !== counterpart[key]
                ? "conflict-field changed"
                : "conflict-field"
            }
          >
            <dt>
              {label}
              {body[key] !== counterpart[key] && <span>有差异</span>}
            </dt>
            <dd>{display(key, body[key])}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>查看详细内容</summary>
        <pre>{JSON.stringify(body, null, 2)}</pre>
      </details>
    </div>
  );
}
