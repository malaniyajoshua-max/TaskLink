import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  BellRing,
  CheckCheck,
  MessageCircle,
  Plus,
  UserPlus,
  Users,
} from "lucide-react";
import {
  invoke,
  message,
  useCommand,
  type Member,
  type Workspace,
} from "../api";
import {
  Avatar,
  Button,
  Empty,
  ErrorBox,
  Heading,
  Modal,
} from "../components/ui";
export function Collaboration() {
  const workspaces = useCommand("workspaces.list", {}),
    invitations = useCommand("invitations.list", {}),
    friends = useCommand("friends.list", {});
  const [workspace, setWorkspace] = useState<Workspace | null>(null),
    [newWorkspace, setNewWorkspace] = useState(false),
    [name, setName] = useState("");
  const [email, setEmail] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await invoke("sync.run", {});
      await qc.invalidateQueries();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const accepted = (friends.data ?? []).filter((f) => f.status === "accepted");
  const pending = (friends.data ?? []).filter((f) => f.status === "pending");
  return (
    <section>
      <Heading title="协作" description="管理团队工作区、成员、好友和聊天。" />
      <ErrorBox error={error || workspaces.error} />
      <section className="panel">
        <div className="section-header">
          <h3>
            <Users size={18} />
            工作区
          </h3>
          <Button onClick={() => setNewWorkspace(true)}>
            <Plus size={15} />
            创建工作区
          </Button>
        </div>
        <div className="workspace-cards">
          {(workspaces.data ?? []).map((ws) => (
            <button
              key={ws.id}
              className="workspace-card"
              onClick={() => setWorkspace(ws)}
            >
              <strong>{ws.name}</strong>
              <small>
                {ws.role === "owner"
                  ? "所有者"
                  : ws.role === "admin"
                    ? "管理员"
                    : ws.role === "viewer"
                      ? "只读成员"
                      : "成员"}{" "}
                · 管理成员
              </small>
            </button>
          ))}
        </div>
        {!workspaces.isPending && !(workspaces.data ?? []).length && (
          <div className="inline-empty">
            <Users size={20} />
            <span>
              <b>还没有团队工作区</b>
              <small>创建一个工作区，邀请成员共同管理项目。</small>
            </span>
          </div>
        )}
        <ErrorBox error={invitations.error} />
        {(invitations.data ?? []).map((i) => (
          <div className="invite-row" key={i.id}>
            <span>
              邀请加入 <b>{i.name}</b> ·{" "}
              {i.role === "admin"
                ? "管理员"
                : i.role === "viewer"
                  ? "只读成员"
                  : "成员"}
            </span>
            <Button
              disabled={busy}
              onClick={() =>
                run(() =>
                  invoke("invitations.decide", { id: i.id, accept: true }),
                )
              }
            >
              接受
            </Button>
            <Button
              disabled={busy}
              variant="secondary"
              onClick={() =>
                run(() =>
                  invoke("invitations.decide", { id: i.id, accept: false }),
                )
              }
            >
              拒绝
            </Button>
          </div>
        ))}
      </section>
      <div className="collaboration-friends">
        <section className="panel">
          <div className="section-header">
            <h3>好友</h3>
            <Button
              variant="secondary"
              onClick={() => run(() => invoke("chat.open", {}))}
            >
              <MessageCircle size={16} />
              打开聊天
            </Button>
          </div>
          <form
            className="inline-create"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await invoke("friends.add", { email });
                setEmail("");
              });
            }}
          >
            <input
              type="email"
              placeholder="好友邮箱"
              aria-label="好友邮箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Button disabled={busy}>申请</Button>
          </form>
          {pending.map((f) => (
            <div className="friend-request" key={f.id}>
              <b>{f.user.name}</b>
              <small>{f.incoming ? "请求添加你为好友" : "等待对方接受"}</small>
              {f.incoming ? (
                <div className="button-group">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        invoke("friends.decide", { id: f.id, accept: true }),
                      )
                    }
                  >
                    接受
                  </Button>
                  <Button
                    disabled={busy}
                    variant="secondary"
                    onClick={() =>
                      run(() =>
                        invoke("friends.decide", { id: f.id, accept: false }),
                      )
                    }
                  >
                    拒绝
                  </Button>
                </div>
              ) : (
                <Button
                  disabled={busy}
                  variant="secondary"
                  onClick={() =>
                    run(() => invoke("friends.remove", { id: f.id }))
                  }
                >
                  撤回
                </Button>
              )}
            </div>
          ))}
          {accepted.map((f) => (
            <button
              key={f.id}
              className="contact contact-button"
              onClick={() =>
                run(() => invoke("chat.open", { peer_id: f.user.id }))
              }
            >
              <Avatar user={f.user} size={40} />
              <span>
                <b>{f.user.name}</b>
                <small>{f.user.email}</small>
              </span>
              <MessageCircle size={20} />
            </button>
          ))}
          {!accepted.length && !pending.length && (
            <div className="inline-empty">
              <UserPlus size={20} />
              <span>
                <b>还没有好友</b>
                <small>输入对方的绑定邮箱发送好友申请。</small>
              </span>
            </div>
          )}
        </section>
      </div>
      {newWorkspace && (
        <Modal title="创建工作区" onClose={() => setNewWorkspace(false)}>
          <form
            className="editor-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await invoke("workspaces.create", { name });
                setName("");
                setNewWorkspace(false);
              });
            }}
          >
            <label>
              名称
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={160}
                required
              />
            </label>
            <ErrorBox error={error} />
            <Button disabled={busy}>创建</Button>
          </form>
        </Modal>
      )}
      {workspace && (
        <WorkspaceMembers
          workspace={workspace}
          onClose={() => setWorkspace(null)}
        />
      )}
    </section>
  );
}
function WorkspaceMembers({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const query = useCommand("workspaces.members", { id: workspace.id });
  const [email, setEmail] = useState(""),
    [role, setRole] = useState<"member" | "viewer" | "admin">("member"),
    [name, setName] = useState(workspace.name),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [removing, setRemoving] = useState<Member | null>(null);
  const qc = useQueryClient();
  const canAdmin = ["owner", "admin"].includes(workspace.role);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await invoke("sync.run", {});
      await qc.invalidateQueries();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={"工作区 · " + workspace.name} onClose={onClose}>
      <div className="editor-form">
        <ErrorBox error={error || query.error} />
        {canAdmin && (
          <form
            className="inline-create"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() =>
                invoke("workspaces.rename", { id: workspace.id, name }),
              );
            }}
          >
            <input
              aria-label="工作区名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Button disabled={busy}>重命名</Button>
          </form>
        )}
        {(query.data ?? []).map((m) => (
          <div className="member-row" key={m.id}>
            <span>
              <b>{m.name}</b>
              <small>{m.email}</small>
            </span>
            <select
              aria-label={"角色 " + m.name}
              value={m.role}
              disabled={
                !canAdmin ||
                m.role === "owner" ||
                (workspace.role !== "owner" && m.role === "admin") ||
                busy
              }
              onChange={(e) =>
                run(() =>
                  invoke("workspaces.role", {
                    id: workspace.id,
                    user_id: m.id,
                    role: e.target.value as "admin" | "member" | "viewer",
                  }),
                )
              }
            >
              <option value="owner" disabled>
                所有者
              </option>
              <option value="admin" disabled={workspace.role !== "owner"}>
                管理员
              </option>
              <option value="member">成员</option>
              <option value="viewer">只读</option>
            </select>
            {canAdmin && m.role !== "owner" && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setRemoving(m)}
              >
                移除
              </Button>
            )}
          </div>
        ))}
        {removing && (
          <div className="error">
            确认移除 {removing.name}？对方将失去工作区访问权。
            <Button
              variant="danger"
              onClick={() =>
                run(async () => {
                  await invoke("workspaces.remove", {
                    id: workspace.id,
                    user_id: removing.id,
                  });
                  setRemoving(null);
                })
              }
            >
              确认移除
            </Button>
          </div>
        )}
        {canAdmin && (
          <form
            className="editor-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await invoke("workspaces.invite", {
                  id: workspace.id,
                  email,
                  role,
                });
                setEmail("");
              });
            }}
          >
            <h4>邀请新成员</h4>
            <label>
              邮箱
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              角色
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as typeof role)}
              >
                <option value="member">成员</option>
                <option value="viewer">只读成员</option>
                {workspace.role === "owner" && (
                  <option value="admin">管理员</option>
                )}
              </select>
            </label>
            <Button disabled={busy}>发送邀请</Button>
            <small>需要对方在自己的 TaskLink 中接受邀请后才会获得权限。</small>
          </form>
        )}
      </div>
    </Modal>
  );
}
export function Notifications() {
  const query = useCommand("notifications.list", {});
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  async function read(id: string) {
    try {
      await invoke("notifications.read", { id });
      await qc.invalidateQueries();
    } catch (e) {
      setError(message(e));
    }
  }
  const unread = (query.data ?? []).filter((note) => !note.read);
  async function readAll() {
    setBusy(true);
    setError("");
    try {
      await Promise.all(
        unread.map((note) => invoke("notifications.read", { id: note.id })),
      );
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
        title="通知中心"
        description="提醒、邀请和消息动态都在这里。"
        action={
          unread.length ? (
            <Button variant="secondary" disabled={busy} onClick={readAll}>
              <CheckCheck size={16} />
              全部标为已读
            </Button>
          ) : undefined
        }
      />
      <ErrorBox error={error || query.error} />
      {!query.data?.length ? (
        <Empty title="暂无通知" icon={BellRing}>
          <p>新的提醒、邀请和消息动态会显示在这里。</p>
        </Empty>
      ) : (
        <div className="panel">
          {query.data.map((note) => (
            <article
              className={"notification " + (note.read ? "read" : "")}
              key={note.id}
            >
              <div>
                <strong>{note.title}</strong>
                <small>{new Date(note.created_at).toLocaleString()}</small>
              </div>
              <p>{note.body}</p>
              {!note.read && (
                <Button variant="secondary" onClick={() => read(note.id)}>
                  标为已读
                </Button>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
