import { z } from "zod";

export const CHUNK_BYTES = 256 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_STAGED_BYTES = 125 * 1024 * 1024;
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
export const FILE_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  "txt",
  "md",
  "csv",
  "json",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "ods",
  "odp",
  "zip",
  "7z",
];
export const STICKERS = [
  { id: "received", emoji: "👍", label: "收到" },
  { id: "great", emoji: "🤩", label: "太棒了" },
  { id: "thanks", emoji: "🙏", label: "谢谢" },
  { id: "cheer", emoji: "💪", label: "加油" },
  { id: "thinking", emoji: "🤔", label: "让我想想" },
  { id: "celebrate", emoji: "🎉", label: "一起庆祝" },
] as const;
export const stickerId = z.enum([
  "received",
  "great",
  "thanks",
  "cheer",
  "thinking",
  "celebrate",
]);
export type StickerId = z.infer<typeof stickerId>;
export const attachmentSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(180),
    size: z.number().int().positive().max(MAX_FILE_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(["image", "file"]),
    media_type: z.string().max(80),
  })
  .strict();
export type Attachment = z.infer<typeof attachmentSchema>;
export const uploadSchema = attachmentSchema
  .extend({
    ready: z.boolean(),
    uploaded_chunks: z.array(z.number().int().min(0).max(99)).max(100),
  })
  .strict();
export const messageSchema = z
  .object({
    id: z.uuid(),
    sender_id: z.uuid(),
    recipient_id: z.uuid(),
    body: z.string().max(4000),
    created_at: z.string().datetime({ offset: true }),
    sticker_id: stickerId.nullable().default(null),
    attachments: z.array(attachmentSchema).max(5).default([]),
  })
  .strict();
export const draftSchema = z
  .object({
    id: z.uuid(),
    body: z.string().max(4000),
    sticker_id: stickerId.nullable().default(null),
  })
  .strict();
export type ChatDraft = z.infer<typeof draftSchema>;
export interface StagedAttachment extends Attachment {
  peer_id: string;
}
export interface TransferProgress {
  id: string;
  direction: "upload" | "download";
  state: "transferring" | "complete" | "failed" | "cancelled";
  completed: number;
  total: number;
}
export function safeFileName(name: string) {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  return (
    name.length > 0 &&
    name.length <= 180 &&
    name === name.trim() &&
    !name.startsWith(".") &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name) &&
    FILE_EXTENSIONS.includes(extension)
  );
}
export function fileSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${bytes} B`;
}
