import { createHash, randomUUID } from "node:crypto";
import { openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { LocalStore } from "./local-store";
import { AppError } from "./errors";
import {
  attachmentSchema,
  draftSchema,
  CHUNK_BYTES,
  MAX_FILE_BYTES,
  MAX_STAGED_BYTES,
  IMAGE_EXTENSIONS,
  safeFileName,
  type ChatDraft,
  type StagedAttachment,
} from "../shared/chat";

const stagedSchema = attachmentSchema.extend({ peer_id: z.uuid() }).strict();

function decodeStage(
  local: LocalStore,
  row: Record<string, unknown>,
): StagedAttachment {
  const item = stagedSchema.parse(
    JSON.parse(local.decode(String(row.metadata))),
  );
  if (
    row.id !== item.id ||
    row.peer_id !== item.peer_id ||
    Number(row.size) !== item.size
  )
    throw new AppError("invalid_attachment", "本地附件身份信息不一致");
  return item;
}

/** Encrypted staging remains inside the account database, including backups. */
export class ChatStore {
  constructor(readonly local: LocalStore) {}
  staged(peerId?: string): StagedAttachment[] {
    const rows = peerId
      ? this.local.db
          .prepare("SELECT * FROM chat_uploads WHERE peer_id=? ORDER BY rowid")
          .all(peerId)
      : this.local.db
          .prepare("SELECT * FROM chat_uploads ORDER BY rowid")
          .all();
    return rows.map((row) => decodeStage(this.local, row));
  }
  get(id: string): StagedAttachment {
    const row = this.local.db
      .prepare("SELECT * FROM chat_uploads WHERE id=?")
      .get(id);
    if (!row)
      throw new AppError("missing_attachment", "待发送附件不存在，请重新选择");
    return decodeStage(this.local, row);
  }
  chunk(id: string, number: number): Buffer {
    const row = this.local.db
      .prepare(
        "SELECT payload FROM chat_upload_chunks WHERE attachment_id=? AND number=?",
      )
      .get(id, number);
    if (!row)
      throw new AppError("missing_chunk", "本地附件分块缺失，请重新选择文件");
    return Buffer.from(this.local.decode(String(row.payload)), "base64");
  }
  draft(peerId: string): ChatDraft {
    const key = "chatDraft:" + peerId;
    const current = this.local.meta<ChatDraft | null>(key, null);
    if (current) return draftSchema.parse(current);
    const next: ChatDraft = { id: randomUUID(), body: "", sticker_id: null };
    this.local.setMeta(key, next);
    return next;
  }
  saveDraft(peerId: string, draft: ChatDraft) {
    this.local.setMeta("chatDraft:" + peerId, draftSchema.parse(draft));
  }
  remove(id: string) {
    this.local.db.prepare("DELETE FROM chat_uploads WHERE id=?").run(id);
  }
  stage(paths: string[], peerId: string) {
    z.uuid().parse(peerId);
    if (
      !paths.length ||
      paths.length > 5 ||
      this.staged(peerId).length + paths.length > 5
    )
      throw new AppError("too_many_files", "每条消息最多附加 5 个文件");
    let total = Number(
      this.local.db
        .prepare("SELECT coalesce(sum(size),0) n FROM chat_uploads")
        .get()!.n,
    );
    const result: StagedAttachment[] = [];
    this.local.transaction(() => {
      for (const filename of paths) {
        const name = path.basename(filename);
        if (!safeFileName(name))
          throw new AppError(
            "file_type_denied",
            "文件名或类型不受支持；不能发送程序、脚本或快捷方式",
          );
        const info = lstatSync(filename);
        if (!info.isFile() || info.isSymbolicLink())
          throw new AppError(
            "invalid_file",
            "只接受普通文件，不接受文件夹或链接",
          );
        if (info.size <= 0 || info.size > MAX_FILE_BYTES)
          throw new AppError("file_too_large", "文件不能为空且不能超过 25 MB");
        total += info.size;
        if (total > MAX_STAGED_BYTES)
          throw new AppError(
            "staging_full",
            "本机待发送附件超过 125 MB，请先发送或移除附件",
          );
        const id = randomUUID(),
          hash = createHash("sha256"),
          fd = openSync(filename, "r");
        try {
          if (fstatSync(fd).size !== info.size)
            throw new AppError("file_changed", "文件正在变化，请稍后重试");
          this.local.db
            .prepare(
              "INSERT INTO chat_uploads(id,peer_id,size,metadata) VALUES(?,?,?,?)",
            )
            .run(id, peerId, info.size, this.local.encode("{}"));
          let read = 0,
            number = 0;
          while (read < info.size) {
            const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, info.size - read));
            let offset = 0;
            while (offset < chunk.length) {
              const count = readSync(
                fd,
                chunk,
                offset,
                chunk.length - offset,
                read + offset,
              );
              if (!count)
                throw new AppError(
                  "file_changed",
                  "读取文件未完成，请重新选择",
                );
              offset += count;
            }
            hash.update(chunk);
            this.local.db
              .prepare("INSERT INTO chat_upload_chunks VALUES(?,?,?)")
              .run(id, number++, this.local.encode(chunk.toString("base64")));
            read += chunk.length;
          }
          const after = fstatSync(fd);
          if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
            throw new AppError("file_changed", "文件在选择期间被修改，请重试");
          const stage: StagedAttachment = {
            id,
            peer_id: peerId,
            name,
            size: info.size,
            sha256: hash.digest("hex"),
            kind: IMAGE_EXTENSIONS.includes(
              name.split(".").at(-1)!.toLowerCase(),
            )
              ? "image"
              : "file",
            media_type: "application/octet-stream",
          };
          this.local.db
            .prepare("UPDATE chat_uploads SET metadata=? WHERE id=?")
            .run(this.local.encode(JSON.stringify(stage)), id);
          result.push(stage);
        } finally {
          closeSync(fd);
        }
      }
    });
    return result;
  }
}

export function validateChatBackup(local: LocalStore) {
  const store = new ChatStore(local);
  const stages = store.staged();
  if (stages.reduce((sum, item) => sum + item.size, 0) > MAX_STAGED_BYTES)
    throw new AppError("invalid_backup", "备份中的待发送附件超过限制");
  for (const item of stages) {
    if (!safeFileName(item.name))
      throw new AppError("invalid_backup", "备份附件文件名无效");
    const rows = local.db
      .prepare(
        "SELECT number FROM chat_upload_chunks WHERE attachment_id=? ORDER BY number",
      )
      .all(item.id);
    if (rows.length !== Math.ceil(item.size / CHUNK_BYTES))
      throw new AppError("invalid_backup", "备份附件分块缺失");
    const hash = createHash("sha256");
    rows.forEach((row, index) => {
      const chunk = store.chunk(item.id, index);
      if (
        row.number !== index ||
        chunk.length !== Math.min(CHUNK_BYTES, item.size - index * CHUNK_BYTES)
      )
        throw new AppError("invalid_backup", "备份附件分块格式无效");
      hash.update(chunk);
    });
    if (hash.digest("hex") !== item.sha256)
      throw new AppError("invalid_backup", "备份附件哈希不匹配");
  }
  for (const row of local.db
    .prepare("SELECT key FROM meta WHERE key LIKE 'chatDraft:%'")
    .all()) {
    z.uuid().parse(String(row.key).slice(10));
    draftSchema.parse(local.meta(String(row.key), null));
  }
}
