import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, Mail, UserRound } from "lucide-react";
import { invoke, message, type User } from "../api";
import { Brand, Button, ErrorBox, PasswordInput } from "../components/ui";
import { useUI } from "../store";

type View = "login" | "register" | "forgot" | "reset";

export function Auth({
  reauth = false,
  onDone,
}: {
  reauth?: boolean;
  onDone?: () => void;
}) {
  const [view, setView] = useState<View>("login");
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [nickname, setNickname] = useState("");
  const [registrationVerificationId, setRegistrationVerificationId] =
    useState("");
  const [registrationVerificationCode, setRegistrationVerificationCode] =
    useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [resetRequest, setResetRequest] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const qc = useQueryClient();
  const setNewAccountId = useUI((state) => state.setNewAccountId);

  useEffect(() => {
    if (codeCooldown <= 0) return;
    const timer = window.setInterval(
      () => setCodeCooldown((current) => Math.max(0, current - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [codeCooldown > 0]);

  function changeView(next: View) {
    setView(next);
    setError("");
    setNotice("");
    setPassword("");
    setConfirmPassword("");
    setVerificationCode("");
    setCodeCooldown(0);
  }

  function changeRegistrationEmail(value: string) {
    setEmail(value);
    setRegistrationVerificationId("");
    setRegistrationVerificationCode("");
    setCodeCooldown(0);
    setNotice("");
  }

  async function sendRegistrationCode() {
    setCodeBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke("auth.registrationCode", { email });
      setRegistrationVerificationId(result.request_id);
      setCodeCooldown(result.resend_after);
      setNotice("验证码已发送至你的邮箱，10 分钟内有效。");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setCodeBusy(false);
    }
  }

  async function resendPasswordCode() {
    setCodeBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke("auth.passwordForgot", { email });
      setResetRequest(result.request_id);
      setCodeCooldown(result.resend_after);
      setVerificationCode("");
      setNotice("新验证码已发送，请使用最新邮件中的验证码。");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setCodeBusy(false);
    }
  }

  async function authenticate(user: User) {
    setPassword("");
    setConfirmPassword("");
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth.status" });
    qc.setQueryData(["auth.status", {}], user);
    onDone?.();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || codeBusy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (view === "login") {
        await authenticate(
          await invoke("auth.login", { identifier, password }),
        );
      } else if (view === "register") {
        if (password !== confirmPassword)
          throw new Error("两次输入的密码不一致");
        if (!registrationVerificationId) throw new Error("请先获取邮箱验证码");
        const created = await invoke("auth.register", {
          email,
          name: nickname,
          email_verification_id: registrationVerificationId,
          email_verification_code: registrationVerificationCode,
          password,
        });
        setNewAccountId(created.account_id);
        await authenticate(created);
      } else if (view === "forgot") {
        const result = await invoke("auth.passwordForgot", { email });
        setResetRequest(result.request_id);
        setCodeCooldown(result.resend_after);
        setNotice("验证码已发送。请查看邮箱，并在 10 分钟内完成验证。");
        setView("reset");
      } else {
        if (password !== confirmPassword)
          throw new Error("两次输入的新密码不一致");
        await invoke("auth.passwordReset", {
          request_id: resetRequest,
          code: verificationCode,
          password,
        });
        setIdentifier(email);
        changeView("login");
        setNotice("密码已更新，请使用新密码登录。");
      }
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  const title =
    view === "register"
      ? "创建 TaskLink 账号"
      : view === "forgot"
        ? "找回密码"
        : view === "reset"
          ? "验证你的邮箱"
          : "欢迎回来";
  const description =
    view === "register"
      ? "填写基本信息，完成邮箱验证即可开始使用。"
      : view === "forgot"
        ? "输入绑定邮箱，我们会发送一次性验证码。"
        : view === "reset"
          ? "验证码已发送至 " + email
          : reauth
            ? "验证身份后继续。"
            : "登录后继续处理你的任务和日程。";

  return (
    <main className={reauth ? "reauth" : "auth"}>
      {!reauth && (
        <aside className="auth-brand">
          <Brand />
          <div className="auth-story">
            <h2>
              今天要做什么
              <br />
              一眼就知道
            </h2>
            <p>
              把任务、日程、项目和协作放在一起。
              <br />
              需要推进的事，打开就能看到。
            </p>
          </div>
          <img
            className="auth-motif"
            src="./brand-outline.svg"
            alt=""
            aria-hidden="true"
          />
          <div className="auth-flow-lines" aria-hidden="true" />
        </aside>
      )}
      <div className="auth-form-region">
        <div className="auth-panel">
          {view !== "login" && (
            <button
              type="button"
              className="auth-back"
              disabled={busy || codeBusy}
              onClick={() => changeView(view === "reset" ? "forgot" : "login")}
            >
              <ArrowLeft size={16} />
              {view === "reset" ? "更换邮箱" : "返回登录"}
            </button>
          )}
          <h1>{title}</h1>
          <p className="muted">{description}</p>
          <form onSubmit={submit}>
            {view === "register" && (
              <>
                <label>
                  昵称
                  <span className="auth-input">
                    <UserRound size={17} />
                    <input
                      autoComplete="nickname"
                      value={nickname}
                      maxLength={120}
                      onChange={(e) => setNickname(e.target.value)}
                      required
                    />
                  </span>
                </label>
                <label>
                  绑定邮箱
                  <span className="auth-input">
                    <Mail size={17} />
                    <input
                      type="email"
                      autoComplete="email"
                      disabled={busy || codeBusy}
                      value={email}
                      onChange={(e) => changeRegistrationEmail(e.target.value)}
                      required
                    />
                  </span>
                </label>
                <label>
                  邮箱验证码
                  <span className="auth-code-row">
                    <span className="auth-input auth-code-input">
                      <KeyRound size={17} />
                      <input
                        aria-label="邮箱验证码"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6}"
                        maxLength={6}
                        value={registrationVerificationCode}
                        onChange={(e) =>
                          setRegistrationVerificationCode(
                            e.target.value.replace(/\D/g, ""),
                          )
                        }
                        required
                      />
                    </span>
                    <button
                      type="button"
                      className="auth-send-code"
                      disabled={busy || codeBusy || codeCooldown > 0 || !email}
                      onClick={sendRegistrationCode}
                    >
                      {codeBusy
                        ? "发送中…"
                        : codeCooldown > 0
                          ? `${codeCooldown} 秒后重发`
                          : "发送验证码"}
                    </button>
                  </span>
                </label>
              </>
            )}
            {view === "login" && (
              <label>
                账号 / 邮箱
                <span className="auth-input">
                  <UserRound size={17} />
                  <input
                    autoComplete="username"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    required
                  />
                </span>
              </label>
            )}
            {view === "forgot" && (
              <label>
                绑定邮箱
                <span className="auth-input">
                  <Mail size={17} />
                  <input
                    type="email"
                    autoComplete="email"
                    disabled={busy || codeBusy}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </span>
              </label>
            )}
            {view === "reset" && (
              <label>
                6 位验证码
                <span className="auth-code-row">
                  <span className="auth-input auth-code-input">
                    <KeyRound size={17} />
                    <input
                      aria-label="6 位验证码"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      value={verificationCode}
                      onChange={(e) =>
                        setVerificationCode(e.target.value.replace(/\D/g, ""))
                      }
                      required
                    />
                  </span>
                  <button
                    type="button"
                    className="auth-send-code"
                    disabled={busy || codeBusy || codeCooldown > 0}
                    onClick={resendPasswordCode}
                  >
                    {codeBusy
                      ? "发送中…"
                      : codeCooldown > 0
                        ? `${codeCooldown} 秒后重发`
                        : "重新发送"}
                  </button>
                </span>
              </label>
            )}
            {(view === "login" || view === "register" || view === "reset") && (
              <label>
                {view === "reset" ? "新密码" : "密码"}
                <PasswordInput
                  aria-label={view === "reset" ? "新密码" : "密码"}
                  autoComplete={
                    view === "login" ? "current-password" : "new-password"
                  }
                  minLength={view === "login" ? 1 : 10}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                {view !== "login" && (
                  <small className="password-hint">
                    至少 10 个字符，建议使用一句容易记住的短语。
                  </small>
                )}
              </label>
            )}
            {(view === "register" || view === "reset") && (
              <label>
                {view === "reset" ? "确认新密码" : "确认密码"}
                <PasswordInput
                  aria-label={view === "reset" ? "确认新密码" : "确认密码"}
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={128}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
                {confirmPassword && confirmPassword !== password && (
                  <small className="field-error">两次输入的密码不一致</small>
                )}
              </label>
            )}
            {view === "login" && (
              <button
                type="button"
                className="link auth-forgot"
                disabled={busy || codeBusy}
                onClick={() => changeView("forgot")}
              >
                忘记密码？
              </button>
            )}
            {notice && (
              <div className="auth-notice" role="status">
                {notice}
              </div>
            )}
            <ErrorBox error={error} />
            <Button
              disabled={
                busy ||
                codeBusy ||
                (view === "register" &&
                  (!registrationVerificationId ||
                    password !== confirmPassword)) ||
                (view === "reset" && password !== confirmPassword)
              }
              className="full"
            >
              {busy
                ? "正在处理…"
                : view === "register"
                  ? "注册账号"
                  : view === "forgot"
                    ? "发送验证码"
                    : view === "reset"
                      ? "更新密码"
                      : "登录"}
            </Button>
          </form>
          {view === "login" && !reauth && (
            <p className="auth-switch">
              还没有账号？
              <button
                type="button"
                className="link"
                disabled={busy || codeBusy}
                onClick={() => changeView("register")}
              >
                注册账号
              </button>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
