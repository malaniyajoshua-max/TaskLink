import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { backup, restore } from "./data-tools";
import { AppError } from "./errors";
import { LocalStore } from "./local-store";

const magic = Buffer.from("TLBK0001");
const limit = 512 * 1024 * 1024;
function passwordKey(password: string, salt: Buffer) {
  if (password.length < 12 || password.length > 256)
    throw new AppError("backup_password", "备份口令须为 12–256 个字符");
  return scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 3,
    maxmem: 64 * 1024 * 1024,
  });
}
function temporary(local: LocalStore) {
  return mkdtempSync(path.join(path.dirname(local.filename), "backup-work-"));
}

/** Streaming, versioned, password-protected backup including its account key.
 * No tokens are included. The temporary SQLite file is already field-encrypted.
 */
export function portableBackup(
  local: LocalStore,
  filename: string,
  password: string,
) {
  if (existsSync(filename))
    throw new AppError("backup_exists", "请选择新的备份文件名");
  const salt = randomBytes(16),
    nonce = randomBytes(12);
  const key = passwordKey(password, salt);
  const directory = temporary(local),
    snapshot = path.join(directory, "snapshot.sqlite");
  const target = filename + "." + randomBytes(8).toString("hex") + ".tmp";
  let input: number | undefined, output: number | undefined;
  try {
    backup(local, snapshot);
    if (statSync(snapshot).size > limit)
      throw new AppError("file_too_large", "备份上限为 512 MB");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const header = Buffer.concat([magic, salt, nonce]);
    cipher.setAAD(header);
    input = openSync(snapshot, "r");
    output = openSync(target, "wx", 0o600);
    writeSync(output, Buffer.concat([header, Buffer.alloc(16)]));
    writeSync(output, cipher.update(local.cipher.key));
    const chunk = Buffer.alloc(64 * 1024);
    let length: number;
    while ((length = readSync(input, chunk, 0, chunk.length, null)) > 0)
      writeSync(output, cipher.update(chunk.subarray(0, length)));
    writeSync(output, cipher.final());
    writeSync(output, cipher.getAuthTag(), 0, 16, 36);
    fsyncSync(output);
    closeSync(output);
    output = undefined;
    renameSync(target, filename);
  } finally {
    key.fill(0);
    if (input !== undefined) closeSync(input);
    if (output !== undefined) closeSync(output);
    // Both paths are generated directly by this function, never accepted from a backup.
    rmSync(target, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}

export function portableRestore(
  local: LocalStore,
  filename: string,
  password: string,
) {
  if (statSync(filename).size > limit + 84)
    throw new AppError("file_too_large", "备份上限为 512 MB");
  const directory = temporary(local),
    snapshot = path.join(directory, "snapshot.sqlite");
  let input: number | undefined,
    output: number | undefined,
    source: LocalStore | undefined;
  let key: Buffer | undefined, account: Buffer | undefined;
  try {
    input = openSync(filename, "r");
    const header = Buffer.alloc(52);
    if (
      readSync(input, header, 0, 52, null) !== 52 ||
      !header.subarray(0, 8).equals(magic)
    )
      throw new AppError("invalid_backup", "请选择有效的 .tlbackup 加密备份");
    key = passwordKey(password, header.subarray(8, 24));
    const cipher = createDecipheriv(
      "aes-256-gcm",
      key,
      header.subarray(24, 36),
    );
    cipher.setAAD(header.subarray(0, 36));
    cipher.setAuthTag(header.subarray(36, 52));
    output = openSync(snapshot, "wx", 0o600);
    const chunk = Buffer.alloc(64 * 1024);
    let length: number;
    try {
      while ((length = readSync(input, chunk, 0, chunk.length, null)) > 0) {
        let data = cipher.update(chunk.subarray(0, length));
        if (!account) {
          if (data.length < 32) throw new Error("short backup");
          account = Buffer.from(data.subarray(0, 32));
          data = data.subarray(32);
        }
        writeSync(output, data);
      }
      writeSync(output, cipher.final());
    } catch {
      throw new AppError(
        "backup_integrity",
        "备份口令错误或文件已损坏；当前数据未改动",
      );
    }
    fsyncSync(output);
    closeSync(output);
    output = undefined;
    if (!account) throw new AppError("invalid_backup", "备份内容为空");
    source = new LocalStore(snapshot, local.userId, account);
    // Rewrap every confidential field for this installation, keeping operation IDs.
    source.transaction(() => {
      for (const [table, fields] of [
        ["documents", ["snapshot", "server"]],
        ["outbox", ["payload", "prepared", "error"]],
        ["mirror", ["json"]],
        ["reminders", ["json"]],
        ["meta", ["value"]],
        ["chat_uploads", ["metadata"]],
        ["chat_upload_chunks", ["payload"]],
      ] as const) {
        for (const row of source!.db
          .prepare("SELECT rowid AS _rowid,* FROM " + table)
          .all()) {
          if (table === "meta" && ["owner", "schema"].includes(String(row.key)))
            continue;
          for (const field of fields)
            if (row[field] !== null)
              source!.db
                .prepare(`UPDATE ${table} SET ${field}=? WHERE rowid=?`)
                .run(
                  local.encode(source!.decode(String(row[field]))),
                  row._rowid,
                );
        }
      }
    });
    source.close();
    source = undefined;
    restore(local, snapshot);
  } finally {
    source?.close();
    key?.fill(0);
    account?.fill(0);
    if (input !== undefined) closeSync(input);
    if (output !== undefined) closeSync(output);
    rmSync(directory, { recursive: true, force: true });
  }
}
