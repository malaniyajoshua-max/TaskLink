import { useTheme } from "../use-theme";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  Check,
  ChevronUp,
  Download,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  MessageCircle,
  Paperclip,
  Search,
  Send,
  Smile,
  Sticker,
  UploadCloud,
  WifiOff,
  X,
} from "lucide-react";
import {
  invoke,
  message,
  useCommand,
  type User,
  type Friend,
  type Message,
  type Attachment,
  type ChatDraft,
  type TransferProgress,
  STICKERS,
  fileSize,
} from "../api";
import {
  Avatar,
  Button,
  Empty,
  ErrorBox,
  Loading,
  Modal,
} from "../components/ui";
import "./chat.css";

const EMOJI = [
  "😀",
  "😄",
  "😊",
  "🥰",
  "😍",
  "🤩",
  "😂",
  "🤣",
  "😉",
  "😎",
  "🤔",
  "🥺",
  "😭",
  "😮",
  "😴",
  "🙌",
  "👍",
  "👌",
  "🙏",
  "💪",
  "❤️",
  "🎉",
  "✨",
  "☕",
  "✅",
  "🌻",
  "🔥",
  "🚀",
  "👋",
  "🤝",
  "🎂",
  "💡",
];
function previewText(value?: Message) {
  return !value
    ? "点击开始聊天"
    : value.body ||
        (value.sticker_id
          ? "[表情包] " + STICKERS.find((s) => s.id === value.sticker_id)?.label
          : value.attachments?.some((a) => a.kind === "image")
            ? "[图片]"
            : "[文件]");
}
function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
function dayLabel(value: string) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? "今天"
    : date.toLocaleDateString("zh-CN", {
        year:
          date.getFullYear() === new Date().getFullYear()
            ? undefined
            : "numeric",
        month: "long",
        day: "numeric",
      });
}

export function ChatWindow({ user }: { user: User }) {
  const friends = useCommand("friends.list", {}),
    context = useCommand("chat.context", {}),
    conversations = useCommand("chat.conversations", {}),
    preferences = useCommand("settings.get", {}),
    status = useCommand("sync.status", {});
  const [peerId, setPeerId] = useState<string | null>(null),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [avatarBusy, setAvatarBusy] = useState(false);
  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase());
  useEffect(() => {
    document.body.classList.add("chat-document");
    return () => document.body.classList.remove("chat-document");
  }, []);
  useEffect(() => {
    if (context.data?.peer_id) setPeerId(context.data.peer_id);
  }, [context.data?.peer_id]);
  useEffect(() => window.tasklink!.onChatPeer(setPeerId), []);
  useTheme(preferences.data?.theme);
  useEffect(() => {
    const poll = () => {
      if (!document.hidden) void invoke("sync.run", {}).catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, []);
  const last = useMemo(
    () => new Map((conversations.data ?? []).map((c) => [c.peer_id, c.last])),
    [conversations.data],
  );
  const accepted = (friends.data ?? []).filter((f) => f.status === "accepted");
  const contacts = accepted
    .filter((f) =>
      `${f.user.name} ${f.user.email}`
        .toLocaleLowerCase()
        .includes(deferredSearch),
    )
    .sort(
      (a, b) =>
        (last.get(b.user.id)?.created_at ?? "").localeCompare(
          last.get(a.user.id)?.created_at ?? "",
        ) || a.user.name.localeCompare(b.user.name),
    );
  const peer = friends.data?.find((friend) => friend.user.id === peerId);
  async function changeAvatar() {
    setError("");
    setAvatarBusy(true);
    try {
      await invoke("profile.avatar", {});
    } catch (e) {
      setError(message(e));
    } finally {
      setAvatarBusy(false);
    }
  }
  return (
    <main className="chat-window" aria-label="独立聊天窗口">
      <aside className="chat-rail" aria-label="会话列表">
        <header className="chat-rail-heading">
          <h1>聊天</h1>
          <MessageCircle size={22} />
        </header>
        <label className="chat-search">
          <Search size={17} />
          <input
            aria-label="搜索好友"
            placeholder="搜索好友"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="chat-contacts">
          {contacts.map((friend) => (
            <button
              key={friend.id}
              className={
                "chat-contact " + (peerId === friend.user.id ? "selected" : "")
              }
              aria-label={`与${friend.user.name}聊天`}
              aria-pressed={peerId === friend.user.id}
              onClick={() => setPeerId(friend.user.id)}
            >
              <Avatar user={friend.user} size={44} />
              <span className="chat-contact-copy">
                <span>
                  <strong>{friend.user.name}</strong>
                  {last.has(friend.user.id) && (
                    <time>
                      {timeLabel(last.get(friend.user.id)!.created_at)}
                    </time>
                  )}
                </span>
                <small>{previewText(last.get(friend.user.id))}</small>
              </span>
            </button>
          ))}
          {!contacts.length && (
            <p className="chat-rail-hint">
              {deferredSearch
                ? "没有匹配的好友"
                : "在协作页面添加好友后，即可在这里开始聊天。"}
            </p>
          )}
        </div>
        <ErrorBox error={error || friends.error} />
        <button
          className="chat-self"
          onClick={changeAvatar}
          disabled={avatarBusy}
          aria-label="更换头像"
        >
          <Avatar user={user} size={40} />
          <span>
            <strong>{user.name}</strong>
            <small>{avatarBusy ? "正在更新头像…" : "更换头像"}</small>
          </span>
          <Camera size={18} />
        </button>
      </aside>
      {peer ? (
        <Conversation
          key={peer.user.id}
          user={user}
          peer={peer}
          connection={status.data}
        />
      ) : (
        <section className="chat-welcome">
          <MessageCircle size={48} />
          <h2>从一声问候开始</h2>
          <p>选择左侧好友，发送文字、表情、图片与文件。</p>
          <small>聊天会在这个独立窗口中进行，不打断你的任务。</small>
        </section>
      )}
    </main>
  );
}

function Conversation({
  user,
  peer,
  connection,
}: {
  user: User;
  peer: Friend;
  connection: ReturnType<typeof useCommand<"sync.status">>["data"];
}) {
  const peerId = peer.user.id,
    qc = useQueryClient();
  const [before, setBefore] = useState<{ created_at: string; id: string }>();
  const messages = useCommand("messages.list", {
      peer_id: peerId,
      limit: 100,
      before,
    }),
    saved = useCommand("chat.draft", { peer_id: peerId }),
    activity = useCommand("chat.activity", { peer_id: peerId }),
    files = useCommand("attachments.staged", { peer_id: peerId });
  const [draft, setDraft] = useState<ChatDraft | null>(null),
    [sending, setBusy] = useState(false),
    [staging, setStaging] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [dragging, setDragging] = useState(false),
    [palette, setPalette] = useState<"emoji" | "sticker" | null>(null);
  const [transfers, setTransfers] = useState<Record<string, TransferProgress>>(
    {},
  );
  const draftRef = useRef<ChatDraft | null>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    history = useRef<HTMLDivElement>(null),
    paletteRoot = useRef<HTMLDivElement>(null),
    dragDepth = useRef(0),
    followLatest = useRef(true);
  const busy = sending || !!activity.data?.sending;
  const blocked = peer.status !== "accepted",
    offline =
      connection?.paused ||
      connection?.state === "offline" ||
      connection?.state === "auth_required";
  useEffect(() => {
    if (
      saved.data &&
      (!draftRef.current || draftRef.current.id !== saved.data.id)
    ) {
      draftRef.current = saved.data;
      setDraft(saved.data);
    }
  }, [saved.data]);
  useEffect(
    () =>
      window.tasklink!.onTransfer((value) =>
        setTransfers((previous) => ({ ...previous, [value.id]: value })),
      ),
    [],
  );
  useEffect(() => {
    if (followLatest.current && history.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [messages.data]);
  useEffect(() => {
    if (!palette) return;
    const close = (event: MouseEvent) => {
      if (!paletteRoot.current?.contains(event.target as Node))
        setPalette(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [palette]);
  function updateDraft(change: Partial<ChatDraft>) {
    if (!draftRef.current) return;
    const next = { ...draftRef.current, ...change };
    draftRef.current = next;
    setDraft(next);
    void invoke("chat.saveDraft", { peer_id: peerId, draft: next }).catch((e) =>
      setError(message(e)),
    );
  }
  async function send() {
    if (
      !draft ||
      busy ||
      staging ||
      blocked ||
      (!draft.body.trim() && !draft.sticker_id && !files.data?.length)
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    setPalette(null);
    try {
      await invoke("messages.send", {
        ...draft,
        recipient_id: peerId,
        attachment_ids: (files.data ?? []).map((f) => f.id),
      });
      const next = await invoke("chat.draft", { peer_id: peerId });
      draftRef.current = next;
      setDraft(next);
      followLatest.current = true;
      setBefore(undefined);
      await qc.invalidateQueries({
        predicate: (q) =>
          [
            "messages.list",
            "attachments.staged",
            "chat.conversations",
          ].includes(String(q.queryKey[0])),
      });
      textarea.current?.focus();
    } catch (e) {
      setError(message(e) + "。草稿已保留，可重试发送。");
    } finally {
      setBusy(false);
    }
  }
  async function choose(imagesOnly: boolean) {
    setStaging(true);
    setError("");
    try {
      await invoke("attachments.pick", {
        peer_id: peerId,
        images_only: imagesOnly,
      });
      await files.refetch();
    } catch (e) {
      setError(message(e));
    } finally {
      setStaging(false);
    }
  }
  async function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    if (busy || staging || blocked) return;
    const incoming = Array.from(event.dataTransfer.files);
    if (!incoming.length) {
      setError("请拖入磁盘上的图片或文件，不支持拖入网址。");
      return;
    }
    setStaging(true);
    setError("");
    try {
      await window.tasklink!.stageFiles(incoming, peerId);
      await files.refetch();
    } catch (e) {
      setError(message(e));
    } finally {
      setStaging(false);
    }
  }
  async function remove(id: string) {
    setError("");
    try {
      await invoke("attachments.remove", { id });
      await files.refetch();
    } catch (e) {
      setError(message(e));
    }
  }
  function emoji(value: string) {
    const input = textarea.current,
      current = draftRef.current;
    if (!input || !current) return;
    const start = input.selectionStart ?? current.body.length,
      end = input.selectionEnd ?? start;
    const body = current.body.slice(0, start) + value + current.body.slice(end);
    if (body.length > 4000) return;
    updateDraft({ body });
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + value.length, start + value.length);
    });
  }
  async function download(attachment: Attachment) {
    setError("");
    setNotice("");
    try {
      const result = await invoke("attachments.save", { id: attachment.id });
      if (!result.canceled)
        setNotice(`已保存「${result.name}」。打开前请确认文件来源。`);
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <section
      className="chat-conversation"
      aria-label={`与${peer.user.name}的会话`}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          if (!busy && !blocked) {
            dragDepth.current++;
            setDragging(true);
          }
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = busy || blocked ? "none" : "copy";
        }
      }}
      onDrop={drop}
    >
      <header className="chat-peer-heading">
        <Avatar user={peer.user} size={46} />
        <div>
          <h2>{peer.user.name}</h2>
          <small>{blocked ? "好友关系已解除" : "好友"}</small>
        </div>
        <Button
          variant="ghost"
          aria-label="关闭聊天窗口"
          onClick={() => invoke("chat.close", {})}
        >
          <X size={22} />
        </Button>
      </header>
      {(offline || blocked) && (
        <div className="chat-connection" role="status">
          <WifiOff size={15} />
          {blocked
            ? "仅显示已缓存记录。重新添加好友后才能发送和下载附件。"
            : connection?.state === "auth_required"
              ? "登录已过期，请回到任务窗口重新登录。"
              : "当前网络不可用。你可以继续编辑，恢复连接后再发送。"}
        </div>
      )}
      <div
        className="chat-history"
        role="log"
        aria-label="聊天记录"
        ref={history}
        onScroll={() => {
          const node = history.current!;
          followLatest.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 100;
        }}
      >
        <div className="chat-history-controls">
          {messages.data?.length === 100 && (
            <Button
              variant="text"
              onClick={() => {
                const first = messages.data![0];
                followLatest.current = true;
                setBefore({ id: first.id, created_at: first.created_at });
              }}
            >
              <ChevronUp size={14} />
              更早消息
            </Button>
          )}
          {before && (
            <Button
              variant="text"
              onClick={() => {
                followLatest.current = true;
                setBefore(undefined);
              }}
            >
              回到最新
            </Button>
          )}
        </div>
        {messages.isPending ? (
          <Loading />
        ) : !messages.data?.length ? (
          <Empty title="还没有消息" icon={MessageCircle}>
            <p>发送第一条消息，对方回复后会显示在这里。</p>
          </Empty>
        ) : (
          messages.data.map((item, index, all) => (
            <div key={item.id}>
              {(index === 0 ||
                dayLabel(all[index - 1].created_at) !==
                  dayLabel(item.created_at)) && (
                <div className="chat-date">
                  <span>{dayLabel(item.created_at)}</span>
                </div>
              )}
              <MessageBubble
                item={item}
                sender={item.sender_id === user.id ? user : peer.user}
                own={item.sender_id === user.id}
                onDownload={download}
                transfers={transfers}
                disabled={blocked}
              />
            </div>
          ))
        )}
      </div>
      <div className="chat-editor">
        <ErrorBox
          error={error || messages.error || saved.error || files.error}
        />
        {notice && (
          <p className="chat-notice" role="status">
            <Check size={15} />
            {notice}
          </p>
        )}
        {files.data?.length || draft?.sticker_id ? (
          <div className="chat-pending" aria-label="待发送内容">
            {files.data?.map((file) => (
              <div className="chat-pending-file" key={file.id}>
                {file.kind === "image" ? (
                  <ImageIcon size={25} />
                ) : (
                  <FileText size={25} />
                )}
                <span>
                  <strong>{file.name}</strong>
                  <small>
                    {transfers[file.id]?.state === "transferring"
                      ? `上传 ${Math.round((transfers[file.id].completed / file.size) * 100)}%`
                      : `${fileSize(file.size)} · 待发送`}
                  </small>
                </span>
                {busy && transfers[file.id]?.state === "transferring" ? (
                  <Button
                    variant="ghost"
                    type="button"
                    aria-label={`取消传输 ${file.name}`}
                    onClick={() =>
                      invoke("attachments.cancel", { id: file.id })
                    }
                  >
                    <X size={15} />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={busy || staging}
                    type="button"
                    aria-label={`移除附件 ${file.name}`}
                    onClick={() => remove(file.id)}
                  >
                    <X size={15} />
                  </Button>
                )}
                {transfers[file.id]?.state === "transferring" && (
                  <progress
                    value={transfers[file.id].completed}
                    max={file.size}
                  />
                )}
              </div>
            ))}
            {draft?.sticker_id && (
              <div className="chat-pending-sticker">
                <span>
                  {STICKERS.find((s) => s.id === draft.sticker_id)?.emoji}
                </span>
                <small>
                  {STICKERS.find((s) => s.id === draft.sticker_id)?.label}
                </small>
                <Button
                  variant="ghost"
                  disabled={busy}
                  aria-label="移除表情包"
                  onClick={() => updateDraft({ sticker_id: null })}
                >
                  <X size={15} />
                </Button>
              </div>
            )}
          </div>
        ) : null}
        <div className="chat-tools" ref={paletteRoot}>
          <Button
            variant="ghost"
            disabled={busy || blocked}
            aria-label="表情与表情包"
            aria-expanded={!!palette}
            onClick={() => setPalette(palette ? null : "emoji")}
          >
            <Smile size={21} />
          </Button>
          <Button
            variant="ghost"
            disabled={busy || staging || blocked}
            aria-label="选择图片"
            onClick={() => choose(true)}
          >
            <ImageIcon size={21} />
          </Button>
          <Button
            variant="ghost"
            disabled={busy || staging || blocked}
            aria-label="添加文件"
            onClick={() => choose(false)}
          >
            <Paperclip size={21} />
          </Button>
          <small>
            {staging ? "正在加密暂存…" : "可拖入图片或文件 · 单个不超过 25 MB"}
          </small>
          {palette && (
            <div
              className="chat-palette"
              role="dialog"
              aria-label="选择表情"
              onKeyDown={(e) => {
                if (e.key === "Escape") setPalette(null);
              }}
            >
              <div className="chat-palette-tabs">
                <button
                  className={palette === "emoji" ? "active" : ""}
                  onClick={() => setPalette("emoji")}
                >
                  <Smile size={16} />
                  表情
                </button>
                <button
                  className={palette === "sticker" ? "active" : ""}
                  onClick={() => setPalette("sticker")}
                >
                  <Sticker size={16} />
                  表情包
                </button>
                <button
                  aria-label="关闭表情面板"
                  onClick={() => setPalette(null)}
                >
                  <X size={16} />
                </button>
              </div>
              {palette === "emoji" ? (
                <div className="chat-emoji-grid">
                  {EMOJI.map((value) => (
                    <button
                      key={value}
                      aria-label={`插入表情 ${value}`}
                      onClick={() => emoji(value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="chat-sticker-grid">
                  {STICKERS.map((value) => (
                    <button
                      key={value.id}
                      aria-label={`选择表情包 ${value.label}`}
                      onClick={() => {
                        updateDraft({ sticker_id: value.id });
                        setPalette(null);
                      }}
                    >
                      <span>{value.emoji}</span>
                      <small>{value.label}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <form
          className="chat-input-box"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={textarea}
            aria-label="消息内容"
            placeholder={blocked ? "请先重新添加好友" : "输入消息…"}
            value={draft?.body ?? ""}
            disabled={!draft || busy || blocked}
            maxLength={4000}
            onChange={(e) => updateDraft({ body: e.target.value })}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <footer>
            <small>Enter 发送 · Shift+Enter 换行</small>
            <Button
              disabled={
                !draft ||
                busy ||
                staging ||
                blocked ||
                (!draft.body.trim() && !draft.sticker_id && !files.data?.length)
              }
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Send size={16} />
              )}
              {busy ? "发送中…" : "发送"}
            </Button>
          </footer>
        </form>
      </div>
      {dragging && (
        <div className="chat-drop-overlay" aria-label="拖放上传区域">
          <UploadCloud size={44} />
          <strong>松开添加到待发送列表</strong>
          <span>图片、GIF 与文件 · 点击发送后才会传输</span>
        </div>
      )}
    </section>
  );
}

function MessageBubble({
  item,
  sender,
  own,
  onDownload,
  transfers,
  disabled,
}: {
  item: Message;
  sender: User;
  own: boolean;
  onDownload: (file: Attachment) => void;
  transfers: Record<string, TransferProgress>;
  disabled: boolean;
}) {
  const sticker = STICKERS.find((s) => s.id === item.sticker_id);
  return (
    <article
      className={"chat-message " + (own ? "own" : "incoming")}
      data-message-id={item.id}
    >
      <Avatar user={sender} size={34} />
      <div className="chat-message-content">
        {item.body && (
          <div className="chat-bubble">
            <p dir="auto">{item.body}</p>
          </div>
        )}
        {sticker && (
          <div
            className="chat-sticker-message"
            aria-label={`表情包：${sticker.label}`}
          >
            <span>{sticker.emoji}</span>
            <small>{sticker.label}</small>
          </div>
        )}
        {item.attachments?.map((file) => (
          <div key={file.id} className="chat-attachment">
            {file.kind === "image" && (
              <ImageMessage
                file={file}
                disabled={disabled}
                onDownload={() => onDownload(file)}
              />
            )}
            <div
              className={
                "chat-file " + (file.kind === "image" ? "image-caption" : "")
              }
            >
              <FileText size={26} />
              <span>
                <strong title={file.name}>{file.name}</strong>
                <small>
                  {fileSize(file.size)}
                  {transfers[file.id]?.state === "transferring"
                    ? ` · 下载 ${Math.round((transfers[file.id].completed / file.size) * 100)}%`
                    : ""}
                </small>
              </span>
              <Button
                variant="ghost"
                aria-label={`另存为 ${file.name}`}
                disabled={
                  disabled || transfers[file.id]?.state === "transferring"
                }
                onClick={() => onDownload(file)}
              >
                <Download size={18} />
              </Button>
            </div>
          </div>
        ))}
        <time dateTime={item.created_at}>{timeLabel(item.created_at)}</time>
      </div>
    </article>
  );
}

function ImageMessage({
  file,
  disabled,
  onDownload,
}: {
  file: Attachment;
  disabled: boolean;
  onDownload: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [visible, setVisible] = useState(false),
    [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const preview = useQuery({
    queryKey: ["attachments.preview", { id: file.id }],
    queryFn: () => invoke("attachments.preview", { id: file.id }),
    enabled: visible && !disabled,
    staleTime: Infinity,
    retry: false,
    gcTime: 60000,
  });
  return (
    <div ref={ref} className="chat-image">
      {preview.data ? (
        <button
          aria-label={`预览图片 ${file.name}`}
          onClick={() => setExpanded(true)}
        >
          <img
            src={preview.data.data_url}
            alt={file.name}
            onLoad={() => {
              const log = ref.current?.closest(".chat-history");
              if (
                log &&
                log.scrollHeight - log.scrollTop - log.clientHeight < 400
              )
                log.scrollTop = log.scrollHeight;
            }}
          />
        </button>
      ) : (
        <button
          className="chat-image-loading"
          disabled={disabled || preview.isFetching}
          onClick={() => preview.refetch()}
        >
          <ImageIcon size={28} />
          <span>
            {disabled
              ? "图片不可用"
              : preview.isError
                ? "图片未加载，点击重试"
                : "正在加载图片…"}
          </span>
        </button>
      )}
      {expanded && preview.data && (
        <Modal
          title={file.name}
          onClose={() => setExpanded(false)}
          className="chat-image-modal"
        >
          <img src={preview.data.data_url} alt={file.name} />
          <div className="chat-image-modal-footer">
            <small>图片预览 · 原文件可另存</small>
            <Button onClick={onDownload}>
              <Download size={16} />
              另存原文件
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
