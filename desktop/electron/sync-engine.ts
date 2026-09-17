import type { ApiSchemas, SyncStatus } from "../shared/contract";
import { pullResponse, pushResponse } from "./wire";
import { AppError } from "./errors";
import { LocalStore } from "./local-store";
import { Network } from "./network";

export class SyncEngine {
  private running: Promise<SyncStatus> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private state: SyncStatus["state"] = "idle";
  private error: string | null = null;
  paused = false;
  constructor(
    readonly local: LocalStore,
    readonly network: Network,
    private changed: (dataChanged?: boolean) => void,
  ) {
    this.paused = local.meta("syncPaused", false);
  }
  status(): SyncStatus {
    const counts = this.local.queueStats();
    const retries = counts.nextRetry ? [counts.nextRetry] : [];
    const nextAttempt = this.local.meta("nextSyncAttempt", 0);
    if (nextAttempt > Date.now()) retries.push(nextAttempt);
    return {
      state: this.paused ? "offline" : this.state,
      pending: counts.pending,
      conflicts: counts.conflicts,
      lastSynced: this.local.meta<string | null>("lastSynced", null),
      error: this.error,
      nextRetry: retries.length ? Math.min(...retries) : null,
      paused: this.paused,
    };
  }
  schedule(delay = 1000) {
    if (this.stopped) return;
    delay = Math.max(delay, this.local.meta("nextSyncAttempt", 0) - Date.now());
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.run();
    }, delay);
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.running) await this.running;
  }
  run(force = false): Promise<SyncStatus> {
    if (this.running) return this.running;
    if (this.paused || this.stopped) return Promise.resolve(this.status());
    this.running = this.perform(force).finally(() => {
      this.running = null;
      if (!this.stopped)
        this.schedule(this.local.pendingCount() ? 2000 : 15000);
    });
    return this.running;
  }
  private async perform(force: boolean): Promise<SyncStatus> {
    this.state = "syncing";
    let dataChanged = false;
    this.changed(false);
    try {
      await this.network.revokePending();
      for (
        let round = 0;
        round < 30 && !this.paused && !this.stopped;
        round++
      ) {
        const batch = this.local.prepareBatch(force && round === 0);
        if (!batch.length) break;
        try {
          const payload = {
            operations: batch,
          } satisfies ApiSchemas["SyncPushIn"];
          const result = pushResponse.parse(
            await this.network.request<ApiSchemas["SyncPushOut"]>(
              "/sync/push",
              "POST",
              payload,
            ),
          );
          if (
            result.results.length !== batch.length ||
            result.results.some(
              (r, i) => r.operation_id !== batch[i].operation_id,
            )
          )
            throw new AppError(
              "invalid_sync_response",
              "同步响应与提交批次不一致",
            );
          this.local.acknowledge(result.results);
          dataChanged = true;
        } catch (error) {
          this.local.retry(batch);
          throw error;
        }
      }
      let more = true;
      while (more && !this.paused && !this.stopped) {
        const cursor = this.local.meta("cursor", 0);
        const result = pullResponse.parse(
          await this.network.request<ApiSchemas["SyncPullOut"]>(
            "/sync/pull?cursor=" + cursor + "&limit=200",
          ),
        );
        if (
          result.cursor < cursor ||
          (result.has_more && result.cursor === cursor)
        )
          throw new AppError("invalid_cursor", "服务器同步游标无效");
        this.local.applyChanges(result.changes, result.cursor);
        dataChanged ||= result.changes.length > 0;
        more = result.has_more;
      }
      if (!this.paused && !this.stopped) {
        this.local.setMeta("lastSynced", new Date().toISOString());
        this.local.setMeta("syncFailures", 0);
        this.local.setMeta("nextSyncAttempt", 0);
      }
      this.state = "idle";
      this.error = null;
    } catch (error) {
      const failures = Math.min(this.local.meta("syncFailures", 0) + 1, 10);
      this.local.setMeta("syncFailures", failures);
      this.local.setMeta(
        "nextSyncAttempt",
        Date.now() +
          Math.min(60000, 1000 * 2 ** failures) +
          Math.floor(Math.random() * 500),
      );
      const code = error instanceof AppError ? error.code : "internal_error";
      this.state =
        code === "network_unavailable"
          ? "offline"
          : ["session_expired", "auth_required"].includes(code)
            ? "auth_required"
            : "error";
      this.error =
        error instanceof AppError ? error.message : "同步失败，本地记录仍保留";
    }
    this.changed(dataChanged);
    return this.status();
  }
}
