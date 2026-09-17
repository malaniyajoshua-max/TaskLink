export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function safeError(error: unknown) {
  if (error instanceof AppError)
    return { code: error.code, message: error.message };
  return {
    code: "internal_error",
    message: "操作未完成，请重试。若持续发生，请备份本地数据。",
  };
}
