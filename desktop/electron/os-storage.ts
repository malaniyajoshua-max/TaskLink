import { safeStorage } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { AppError } from "./errors";

const marker = Buffer.from("TLDP1");
// The script is constant. Secrets travel only through redirected standard input,
// never through a shell command, process argument, environment variable or log.
// Direct per-user DPAPI avoids a crash window before Chromium flushes Local State.
const script = `Add-Type -AssemblyName System.Security
try {
  $operation = [Console]::In.ReadLine()
  $inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  if ($operation -eq 'protect') { $outputBytes = [Security.Cryptography.ProtectedData]::Protect($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
  elseif ($operation -eq 'unprotect') { $outputBytes = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
  else { [Environment]::Exit(1) }
  [Console]::Out.Write([Convert]::ToBase64String($outputBytes))
} catch { [Environment]::Exit(1) }`;

async function dpapi(
  operation: "protect" | "unprotect",
  value: Buffer,
): Promise<Buffer> {
  if (value.length > 256 * 1024)
    throw new AppError("secure_storage", "安全存储内容过大");
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    let output = "",
      settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(
        new AppError(
          "secure_storage",
          "Windows 安全存储不可用或凭证不属于当前系统账号；原文件未被覆盖",
        ),
      );
    };
    const timer = setTimeout(fail, 15000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 512 * 1024) fail();
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) {
        fail();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.from(output, "base64"));
    });
    child.stdin.end(operation + "\n" + value.toString("base64"));
  });
}

export async function protect(value: string): Promise<Buffer> {
  if (process.platform === "win32")
    return Buffer.concat([marker, await dpapi("protect", Buffer.from(value))]);
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === "linux" &&
      safeStorage.getSelectedStorageBackend() === "basic_text")
  )
    throw new AppError(
      "secure_storage",
      "系统安全存储不可用，禁止明文保存凭证",
    );
  return safeStorage.encryptString(value);
}
export async function unprotect(value: Buffer): Promise<string> {
  if (value.subarray(0, marker.length).equals(marker)) {
    if (process.platform !== "win32")
      throw new AppError(
        "secure_storage",
        "此密钥属于 Windows 系统账号，请使用口令加密备份迁移",
      );
    return (await dpapi("unprotect", value.subarray(marker.length))).toString(
      "utf8",
    );
  }
  // Read existing v2.0 Electron vaults. Main immediately rewraps them in DPAPI.
  try {
    return safeStorage.decryptString(value);
  } catch {
    throw new AppError(
      "secure_storage",
      "旧安全存储无法解密，请保留原文件并从备份恢复",
    );
  }
}
export function isCurrentProtection(value: Buffer) {
  return (
    process.platform !== "win32" ||
    value.subarray(0, marker.length).equals(marker)
  );
}
