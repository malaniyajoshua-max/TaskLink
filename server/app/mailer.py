"""Account verification delivery over authenticated TLS SMTP."""

from email.message import EmailMessage
import os
import smtplib
import ssl


def send_verification_email(email: str, subject: str, content: str):
    host = os.environ.get("TASKLINK_SMTP_HOST")
    sender = os.environ.get("TASKLINK_SMTP_FROM")
    if not host or not sender:
        raise RuntimeError("Account email delivery is not configured")
    port = int(os.environ.get("TASKLINK_SMTP_PORT", "465"))
    security = os.environ.get("TASKLINK_SMTP_SECURITY", "ssl").lower()
    if security not in {"ssl", "starttls"}:
        raise RuntimeError("SMTP must use ssl or starttls")
    message = EmailMessage()
    message["From"] = sender
    message["To"] = email
    message["Subject"] = subject
    message.set_content(content)
    context = ssl.create_default_context()
    client_type = smtplib.SMTP_SSL if security == "ssl" else smtplib.SMTP
    with (
        client_type(host, port, timeout=15, context=context)
        if security == "ssl"
        else client_type(host, port, timeout=15)
    ) as client:
        if security == "starttls":
            client.starttls(context=context)
        username = os.environ.get("TASKLINK_SMTP_USERNAME")
        password = os.environ.get("TASKLINK_SMTP_PASSWORD")
        if username:
            if not password:
                raise RuntimeError("SMTP password is missing")
            client.login(username, password)
        client.send_message(message)


def send_password_reset(email: str, nickname: str, code: str):
    send_verification_email(
        email,
        "TaskLink 密码验证码",
        f"{nickname}，你好：\n\n你的 TaskLink 密码验证码是：{code}\n"
        "验证码将在 10 分钟后失效。如果这不是你的操作，请忽略此邮件。\n",
    )


def send_registration_verification(email: str, code: str):
    send_verification_email(
        email,
        "TaskLink 邮箱验证码",
        f"你的 TaskLink 邮箱验证码是：{code}\n\n"
        "验证码将在 10 分钟后失效。如果这不是你的操作，请忽略此邮件。\n",
    )
