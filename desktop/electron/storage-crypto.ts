import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { AppError } from "./errors";

/** Account-separated authenticated encryption. The installation key is DPAPI-wrapped by main. */
export function accountKey(master: Uint8Array, userId: string): Buffer {
  if (master.byteLength !== 32)
    throw new AppError("storage_key", "数据密钥无效");
  return Buffer.from(
    hkdfSync("sha256", master, userId, "TaskLink storage v2", 32),
  );
}

export class StorageCipher {
  constructor(
    readonly key: Buffer,
    private readonly owner: string,
  ) {
    if (key.length !== 32) throw new AppError("storage_key", "数据密钥无效");
    this.key = Buffer.from(key);
  }
  seal(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from("tasklink:v2:" + this.owner));
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return (
      "tl2:" +
      Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString("base64")
    );
  }
  open(value: string): string {
    try {
      if (!value.startsWith("tl2:")) throw new Error("unencrypted record");
      const bytes = Buffer.from(value.slice(4), "base64");
      if (bytes.length < 29) throw new Error("invalid record");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
      cipher.setAAD(Buffer.from("tasklink:v2:" + this.owner));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString("utf8");
    } catch {
      throw new AppError(
        "storage_integrity",
        "数据密钥不匹配或文件已损坏；已停止读取，未覆盖原数据",
      );
    }
  }
}
