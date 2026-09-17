import { createHash, randomUUID } from "node:crypto";
import {
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  renameSync,
  rmSync,
  readSync,
  fstatSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import {
  Attachment,
  CHUNK_BYTES,
  TransferProgress,
  attachmentSchema,
  messageSchema,
  uploadSchema,
  type StagedAttachment,
} from "../shared/chat";
import { userSchema, type Inputs, type Message } from "../shared/contract";
import { ChatStore } from "./chat-store";
import { Network } from "./network";
import { AppError } from "./errors";

export class ChatTransfers {
  private active = new Map<string, AbortController>();
  private previews = new Map<string, string>();
  private sendingPeers = new Set<string>();
  private sendingFiles = new Set<string>();
  private generation = 0;
  constructor(
    readonly store: ChatStore,
    private network: Network,
    private progress: (value: TransferProgress) => void,
    private changed: () => void,
    private online: () => boolean,
  ) {}
  private requireOnline() {
    if (!this.online())
      throw new AppError(
        "offline",
        "发送文件需要网络连接。你可以保留当前草稿，稍后继续发送",
      );
  }
  cancel(id: string) {
    this.active.get(id)?.abort();
  }
  cancelAll() {
    this.generation++;
    for (const item of this.active.values()) item.abort();
    this.previews.clear();
  }
  private status(
    file: Attachment,
    direction: TransferProgress["direction"],
    completed: number,
    state: TransferProgress["state"] = "transferring",
  ) {
    this.progress({
      id: file.id,
      direction,
      completed,
      total: file.size,
      state,
    });
  }
  private async upload(file: StagedAttachment) {
    const controller = new AbortController();
    this.active.set(file.id, controller);
    this.status(file, "upload", 0);
    try {
      this.requireOnline();
      const route = "/attachments/" + file.id;
      const begun = uploadSchema.parse(
        await this.network.request(
          "/attachments",
          "POST",
          {
            id: file.id,
            recipient_id: file.peer_id,
            name: file.name,
            size: file.size,
            sha256: file.sha256,
          },
          { signal: controller.signal },
        ),
      );
      if (!begun.ready) {
        const uploaded = new Set(begun.uploaded_chunks);
        for (let i = 0; i < Math.ceil(file.size / CHUNK_BYTES); i++) {
          if (controller.signal.aborted)
            throw new AppError(
              "transfer_cancelled",
              "传输已取消，可重试继续发送",
            );
          this.requireOnline();
          if (!uploaded.has(i))
            await this.network.request(
              route + "/chunks/" + i,
              "PUT",
              undefined,
              {
                bytes: this.store.chunk(file.id, i),
                signal: controller.signal,
              },
            );
          this.status(
            file,
            "upload",
            Math.min(file.size, (i + 1) * CHUNK_BYTES),
          );
        }
      }
      const result = attachmentSchema.parse(
        await this.network.request(route + "/complete", "POST", undefined, {
          signal: controller.signal,
        }),
      );
      if (
        result.id !== file.id ||
        result.sha256 !== file.sha256 ||
        result.size !== file.size
      )
        throw new AppError("invalid_response", "附件确认内容与本地文件不一致");
      this.status(file, "upload", file.size, "complete");
      return result;
    } catch (error) {
      this.status(
        file,
        "upload",
        0,
        controller.signal.aborted ? "cancelled" : "failed",
      );
      throw error;
    } finally {
      this.active.delete(file.id);
    }
  }
  isSending(peer: string) {
    return this.sendingPeers.has(peer);
  }
  async send(input: Inputs["messages.send"]) {
    if (this.isSending(input.recipient_id))
      throw new AppError("transfer_busy", "此会话正在发送，请稍后重试");
    this.sendingPeers.add(input.recipient_id);
    for (const id of input.attachment_ids ?? []) this.sendingFiles.add(id);
    this.changed();
    try {
      return await this.sendMessage(input);
    } finally {
      this.sendingPeers.delete(input.recipient_id);
      for (const id of input.attachment_ids ?? []) this.sendingFiles.delete(id);
      this.changed();
    }
  }
  private async sendMessage(input: Inputs["messages.send"]) {
    this.requireOnline();
    const id = input.id ?? randomUUID();
    const prior = this.store.local.message(id);
    if (prior) {
      if (
        prior.sender_id !== this.store.local.userId ||
        prior.recipient_id !== input.recipient_id ||
        prior.body !== input.body ||
        (prior.sticker_id ?? null) !== (input.sticker_id ?? null) ||
        JSON.stringify(prior.attachments?.map((file) => file.id) ?? []) !==
          JSON.stringify(input.attachment_ids ?? [])
      )
        throw new AppError(
          "duplicate_message",
          "消息标识已被其他内容使用，请重新打开会话后发送",
        );
      this.store.local.transaction(() => {
        for (const fileId of input.attachment_ids ?? [])
          this.store.remove(fileId);
        this.store.saveDraft(input.recipient_id, {
          id: randomUUID(),
          body: "",
          sticker_id: null,
        });
      });
      this.changed();
      return prior;
    }
    for (const attachmentId of input.attachment_ids ?? []) {
      const file = this.store.get(attachmentId);
      if (file.peer_id !== input.recipient_id)
        throw new AppError("wrong_recipient", "附件不属于当前会话");
      await this.upload(file);
    }
    const result = messageSchema.parse(
      await this.network.request("/messages", "POST", { ...input, id }),
    );
    if (
      result.id !== id ||
      result.sender_id !== this.store.local.userId ||
      result.recipient_id !== input.recipient_id
    )
      throw new AppError("invalid_response", "消息确认与发送内容不一致");
    this.store.local.transaction(() => {
      this.store.local.mirror("message", result.id, result);
      for (const fileId of input.attachment_ids ?? [])
        this.store.remove(fileId);
      this.store.saveDraft(input.recipient_id, {
        id: randomUUID(),
        body: "",
        sticker_id: null,
      });
    });
    this.changed();
    return result;
  }
  async remove(id: string) {
    if (this.sendingFiles.has(id))
      throw new AppError("transfer_busy", "请先取消发送，再移除附件");
    this.store.remove(id);
    if (this.online())
      await this.network
        .request("/attachments/" + id, "DELETE")
        .catch(() => {});
    this.changed();
  }
  async info(id: string) {
    this.requireOnline();
    const file = attachmentSchema.parse(
      await this.network.request("/attachments/" + id),
    );
    if (file.id !== id)
      throw new AppError("invalid_response", "附件身份不一致");
    return file;
  }
  async preview(id: string) {
    const cached = this.previews.get(id);
    if (cached) return { data_url: cached };
    const file = await this.info(id);
    if (file.kind !== "image") throw new AppError("not_image", "不是图片附件");
    const bytes = Buffer.from(
      await this.network.request<Uint8Array>(
        "/attachments/" + id + "/preview",
        "GET",
        undefined,
        { binary: true },
      ),
    );
    if (
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP"
    )
      throw new AppError("invalid_image", "图片预览格式无效");
    const url = "data:image/webp;base64," + bytes.toString("base64");
    this.previews.set(id, url);
    let size = [...this.previews.values()].reduce(
      (n, item) => n + item.length,
      0,
    );
    while (size > 16 * 1024 * 1024) {
      const first = this.previews.keys().next().value!;
      size -= this.previews.get(first)!.length;
      this.previews.delete(first);
    }
    return { data_url: url };
  }
  async save(id: string, destination: string) {
    if (this.active.has(id))
      throw new AppError("transfer_busy", "此附件已在传输中");
    const generation = this.generation;
    const file = await this.info(id),
      controller = new AbortController();
    if (generation !== this.generation)
      throw new AppError("transfer_cancelled", "传输已取消");
    this.active.set(id, controller);
    const temporary = destination + ".tasklink-" + randomUUID() + ".partial";
    let fd: number | undefined;
    this.status(file, "download", 0);
    try {
      fd = openSync(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      for (let i = 0; i < Math.ceil(file.size / CHUNK_BYTES); i++) {
        this.requireOnline();
        const bytes = Buffer.from(
          await this.network.request<Uint8Array>(
            "/attachments/" + id + "/chunks/" + i,
            "GET",
            undefined,
            { binary: true, signal: controller.signal },
          ),
        );
        if (bytes.length !== Math.min(CHUNK_BYTES, file.size - i * CHUNK_BYTES))
          throw new AppError(
            "attachment_integrity",
            "附件分块长度不一致，未保存到目标文件",
          );
        hash.update(bytes);
        let written = 0;
        while (written < bytes.length)
          written += writeSync(fd, bytes, written, bytes.length - written);
        this.status(
          file,
          "download",
          Math.min(file.size, (i + 1) * CHUNK_BYTES),
        );
      }
      if (hash.digest("hex") !== file.sha256)
        throw new AppError(
          "attachment_integrity",
          "文件 SHA256 校验失败，未保存到目标文件",
        );
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      if (process.platform === "win32")
        writeFileSync(
          temporary + ":Zone.Identifier",
          "[ZoneTransfer]\r\nZoneId=3\r\n",
          { flush: true },
        );
      renameSync(temporary, destination);
      this.status(file, "download", file.size, "complete");
      return { canceled: false, name: file.name };
    } catch (error) {
      this.status(
        file,
        "download",
        0,
        controller.signal.aborted ? "cancelled" : "failed",
      );
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
      this.active.delete(id);
    }
  }
  async avatar(filename: string) {
    this.requireOnline();
    const info = lstatSync(filename);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size <= 0 ||
      info.size > 5 * 1024 * 1024
    )
      throw new AppError(
        "avatar_size",
        "头像必须是磁盘上的图片，且不能超过 5 MB",
      );
    const fd = openSync(filename, "r"),
      bytes = Buffer.alloc(info.size);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(
          fd,
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!count)
          throw new AppError("file_changed", "头像文件发生变化，请重新选择");
        offset += count;
      }
      const after = fstatSync(fd);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
        throw new AppError("file_changed", "头像文件发生变化，请重新选择");
    } finally {
      closeSync(fd);
    }
    const user = userSchema.parse(
      await this.network.request("/profile/avatar", "PUT", {
        data: bytes.toString("base64"),
      }),
    );
    await this.network.updateUser(user);
    this.changed();
    return { canceled: false, user };
  }
}
