import { z } from "zod";
import { messageSchema } from "../shared/chat";
import {
  id,
  taskBodySchema,
  projectBodySchema,
  userSchema,
  type ApiSchemas,
} from "../shared/contract";

export const authResponse = z
  .object({
    user: userSchema.strict(),
    access_token: z.string().min(32),
    refresh_token: z.string().min(32),
    expires_in: z.number().int().positive(),
  })
  .strict() satisfies z.ZodType<ApiSchemas["AuthOut"]>;
const base = {
  id,
  owner_id: id,
  workspace_id: id.nullable(),
  version: z.number().int().nonnegative(),
  deleted: z.boolean(),
  updated_at: z.string().datetime({ offset: true }),
};
export const entityResponse = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("task"), body: taskBodySchema }).strict(),
  z
    .object({ ...base, kind: z.literal("project"), body: projectBodySchema })
    .strict(),
]);
export const pushResponse = z
  .object({
    results: z
      .array(
        z
          .object({
            operation_id: id,
            status: z.enum(["applied", "conflict", "rejected"]),
            entity: entityResponse.nullable().optional(),
            code: z.string().nullable().optional(),
            message: z.string().nullable().optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const noteResponse = z
  .object({
    id,
    title: z.string(),
    body: z.string(),
    read: z.boolean(),
    created_at: z.string().datetime({ offset: true }),
    local: z.boolean().optional(),
  })
  .strict();
const workspace = z
  .object({
    id,
    name: z.string(),
    owner_id: id,
    role: z.enum(["owner", "admin", "member", "viewer"]),
    version: z.number().int().nonnegative(),
    deleted: z.boolean(),
  })
  .strict();
const friend = z
  .object({
    id,
    user: userSchema.strict(),
    status: z.enum(["pending", "accepted", "rejected"]),
    incoming: z.boolean(),
  })
  .strict();
const message = messageSchema;
const revoked = z
  .object({
    id,
    deleted: z.literal(true),
    revoked: z.literal(true),
    workspace_id: id.optional(),
  })
  .strict();
export function validateMirror(
  kind: string,
  payload: unknown,
): Record<string, unknown> {
  const schemas = { workspace, friend, message, notification: noteResponse };
  const schema = schemas[kind as keyof typeof schemas];
  if (!schema) throw new Error("Unexpected mirror type");
  return schema.parse(payload);
}
export const pullResponse = z
  .object({
    cursor: z.number().int().nonnegative(),
    has_more: z.boolean(),
    changes: z
      .array(
        z
          .object({
            sequence: z.number().int().positive(),
            kind: z.string(),
            entity_id: id,
            payload: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .transform((result) => {
    for (const change of result.changes) {
      const payload = change.payload;
      if (payload.revoked) change.payload = revoked.parse(payload);
      else if (change.kind === "task" || change.kind === "project")
        change.payload = entityResponse.parse(payload);
      else change.payload = validateMirror(change.kind, payload);
      if (change.payload.id !== change.entity_id)
        throw new Error("Mismatched change identity");
    }
    return result;
  }) satisfies z.ZodType<ApiSchemas["SyncPullOut"]>;
