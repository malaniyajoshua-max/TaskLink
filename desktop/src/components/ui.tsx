import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
} from "react";
import {
  AlertCircle,
  CheckSquare2,
  Eye,
  EyeOff,
  LoaderCircle,
  X,
  type LucideIcon,
} from "lucide-react";
import type { User } from "../api";

/** Shared product identity used on authentication and workspace surfaces. */
export function Brand({ className = "" }: { className?: string }) {
  return (
    <div className={"brand " + className}>
      <img src="./brand-mark.svg" width="46" height="36" alt="" />
      <strong>TaskLink</strong>
    </div>
  );
}

/** Stable fallback colour and initial keep avatars recognizable without uploads. */
export function Avatar({ user, size = 40 }: { user: User; size?: number }) {
  const palette = ["#515dec", "#129d99", "#c47633", "#8755c9", "#c45278"];
  const index =
    [...user.id].reduce((sum, value) => sum + value.charCodeAt(0), 0) %
    palette.length;
  return (
    <span
      className="chat-avatar"
      role="img"
      aria-label={`${user.name}的头像`}
      style={
        {
          "--avatar-color": palette[index],
          width: size,
          height: size,
          fontSize: Math.round(size * 0.42),
        } as CSSProperties
      }
    >
      {user.avatar ? (
        <img src={user.avatar} alt="" />
      ) : (
        <span>{Array.from(user.name)[0] ?? "?"}</span>
      )}
    </span>
  );
}

export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="password-input">
      <input {...props} type={visible ? "text" : "password"} />
      <button
        type="button"
        className="password-toggle"
        aria-label={visible ? "隐藏密码" : "显示密码"}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </span>
  );
}

export function DateTimeField(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className="datetime-field" data-empty={!props.value}>
      <input {...props} type="datetime-local" />
      {!props.value && (
        <span className="datetime-placeholder" aria-hidden="true">
          未设置
        </span>
      )}
    </span>
  );
}
export function Button({
  children,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "text";
}) {
  return (
    <button {...props} className={variant + " " + (props.className ?? "")}>
      {children}
    </button>
  );
}
export function Pagination({
  count,
  page,
  onPage,
  size = 100,
}: {
  count: number;
  page: number;
  onPage: (page: number) => void;
  size?: number;
}) {
  const pages = Math.max(1, Math.ceil(count / size)),
    current = Math.min(page, pages - 1);
  if (pages === 1) return null;
  return (
    <nav className="pagination" aria-label="列表分页">
      <span className="muted">
        共 {count.toLocaleString()} 项 · 第 {current + 1} / {pages} 页
      </span>
      <Button
        variant="secondary"
        disabled={current === 0}
        onClick={() => onPage(current - 1)}
      >
        上一页
      </Button>
      <Button
        variant="secondary"
        disabled={current + 1 === pages}
        onClick={() => onPage(current + 1)}
      >
        下一页
      </Button>
    </nav>
  );
}
export function Modal({
  title,
  children,
  onClose,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    // React's autoFocus runs before a native dialog is opened. Focus only once
    // the dialog is visible, so typing works immediately after Ctrl+K/Ctrl+N.
    dialog
      ?.querySelector<HTMLElement>(
        '[data-autofocus], input:not([type="checkbox"]):not([type="range"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)',
      )
      ?.focus({ preventScroll: true });
  }, []);
  return (
    <dialog
      ref={ref}
      className={"dialog " + className}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-header">
        <h3 id={id}>{title}</h3>
        <button
          className="icon-btn"
          type="button"
          aria-label="关闭对话框"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function ErrorBox({ error }: { error: unknown }) {
  return error ? (
    <div className="error" role="alert">
      <AlertCircle size={16} />
      {error instanceof Error ? error.message : String(error)}
    </div>
  ) : null;
}
export function Loading() {
  return (
    <p role="status" className="muted">
      <LoaderCircle size={16} className="spin" />
      正在加载…
    </p>
  );
}
export function Heading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h2>{title}</h2>
        {description && <p className="muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function Empty({
  title,
  children,
  icon: Icon = CheckSquare2,
}: {
  title: string;
  children?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={27} strokeWidth={1.4} />
      </div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}
