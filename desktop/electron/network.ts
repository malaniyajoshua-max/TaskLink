import { AppError } from "./errors";
import { authResponse } from "./wire";
import type { ApiSchemas, Credentials, User, Vault } from "../shared/contract";

export interface TransferOptions {
  bytes?: Uint8Array;
  binary?: boolean;
  signal?: AbortSignal;
}

export class Network {
  private refreshing: Promise<void> | null = null;
  private vaultWrites: Promise<void> = Promise.resolve();
  private commit(update: (latest: Vault) => Vault): Promise<void> {
    const write = this.vaultWrites.then(async () => {
      const next = update(this.vault);
      await this.persist(next);
      this.vault = next;
    });
    this.vaultWrites = write.catch(() => {});
    return write;
  }
  constructor(
    readonly base: string,
    public vault: Vault,
    private persist: (value: Vault) => Promise<void>,
  ) {
    const url = new URL(base);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw new AppError("insecure_server", "非本机服务必须使用 HTTPS");
    if (url.username || url.password || url.search || url.hash)
      throw new AppError("invalid_server", "服务地址包含不允许的字段");
  }
  async raw<T>(
    route: string,
    method = "GET",
    body?: unknown,
    access?: string,
    transfer?: TransferOptions,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.base + route, {
        method,
        headers: {
          "Content-Type": transfer?.bytes
            ? "application/octet-stream"
            : "application/json",
          ...(access ? { Authorization: "Bearer " + access } : {}),
        },
        body: transfer?.bytes
          ? new Uint8Array(transfer.bytes).buffer
          : body === undefined
            ? undefined
            : JSON.stringify(body),
        signal: transfer?.signal
          ? AbortSignal.any([transfer.signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(transfer ? 60000 : 10000),
        redirect: "error",
      });
    } catch {
      if (transfer?.signal?.aborted)
        throw new AppError("transfer_cancelled", "传输已取消，可重新发送");
      throw new AppError(
        "network_unavailable",
        "暂时无法连接。尚未同步的更改会在网络恢复后自动重试",
      );
    }
    if (response.status === 204) return null as T;
    let data: unknown;
    try {
      const limit = transfer?.binary ? 1024 * 1024 : 32 * 1024 * 1024;
      if (Number(response.headers.get("content-length") ?? 0) > limit)
        throw new Error("large response");
      if (
        !(
          transfer?.binary &&
          response.ok &&
          ["application/octet-stream", "image/webp"].includes(
            response.headers.get("content-type") ?? "",
          )
        ) &&
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .includes("application/json")
      )
        throw new Error("invalid media type");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > limit) {
            await reader.cancel();
            throw new Error("large response");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      data =
        transfer?.binary && response.ok
          ? Buffer.concat(chunks)
          : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      if (transfer?.signal?.aborted)
        throw new AppError("transfer_cancelled", "传输已取消，可重新发送");
      throw new AppError("invalid_response", "服务响应格式错误");
    }
    if (!response.ok) {
      const error = data as { code?: string; message?: string };
      throw new AppError(
        response.status === 401
          ? "session_expired"
          : (error.code ?? "request_failed"),
        error.message ?? "服务请求失败",
      );
    }
    return data as T;
  }
  async login(mode: "login" | "register", body: unknown): Promise<User> {
    const result = authResponse.parse(
      await this.raw<ApiSchemas["AuthOut"]>("/auth/" + mode, "POST", body),
    );
    const current: Credentials = {
      user: result.user,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expiresAt: Date.now() + result.expires_in * 1000,
    };
    await this.commit((latest) => ({ ...latest, current }));
    return current.user;
  }
  async requestPasswordReset(body: unknown) {
    return this.raw<ApiSchemas["PasswordResetRequestOut"]>(
      "/auth/password/forgot",
      "POST",
      body,
    );
  }
  async requestRegistrationCode(body: unknown) {
    return this.raw<ApiSchemas["RegistrationVerificationRequestOut"]>(
      "/auth/register/code",
      "POST",
      body,
    );
  }
  async completePasswordReset(body: unknown) {
    return this.raw<ApiSchemas["PasswordResetCompleteOut"]>(
      "/auth/password/reset",
      "POST",
      body,
    );
  }
  private async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const old = this.vault.current;
      if (!old) throw new AppError("auth_required", "请登录");
      const next = authResponse.parse(
        await this.raw<ApiSchemas["AuthOut"]>("/auth/refresh", "POST", {
          refresh_token: old.refresh_token,
        }),
      );
      const current = {
        ...next,
        expiresAt: Date.now() + next.expires_in * 1000,
      };
      await this.commit((latest) => ({ ...latest, current }));
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  async request<T>(
    route: string,
    method = "GET",
    body?: unknown,
    transfer?: TransferOptions,
  ): Promise<T> {
    if (!this.vault.current) throw new AppError("auth_required", "请先登录");
    if (this.vault.current.expiresAt <= Date.now()) await this.refresh();
    try {
      return await this.raw<T>(
        route,
        method,
        body,
        this.vault.current!.access_token,
        transfer,
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "session_expired")
        throw error;
      await this.refresh();
      return this.raw<T>(
        route,
        method,
        body,
        this.vault.current!.access_token,
        transfer,
      );
    }
  }
  async updateUser(user: User) {
    await this.commit((latest) => {
      if (!latest.current || latest.current.user.id !== user.id)
        throw new AppError("auth_required", "账号已经切换");
      return { ...latest, current: { ...latest.current, user } };
    });
  }
  async revokePending() {
    const pending = [...this.vault.revocations];
    for (const refresh_token of pending) {
      try {
        await this.raw("/auth/logout", "POST", { refresh_token });
        await this.commit((latest) => ({
          ...latest,
          revocations: latest.revocations.filter((t) => t !== refresh_token),
        }));
      } catch {
        return;
      }
    }
  }
  async logout() {
    await this.commit((latest) => ({
      current: null,
      revocations: [
        ...latest.revocations,
        ...(latest.current ? [latest.current.refresh_token] : []),
      ],
    }));
    // Offline logout is immediate locally; durable revocations are replayed on reconnection.
    void this.revokePending();
  }
}
