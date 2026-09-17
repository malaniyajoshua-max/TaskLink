import { useQuery } from "@tanstack/react-query";
import type { Command, Inputs, Outputs } from "../shared/contract";
export * from "../shared/contract";

export function invoke<K extends Command>(
  command: K,
  input: Inputs[K],
): Promise<Outputs[K]> {
  if (!window.tasklink)
    return Promise.reject(new Error("请在 TaskLink 桌面应用中打开"));
  return window.tasklink.invoke(command, input);
}
export function useCommand<K extends Command>(
  command: K,
  input: Inputs[K],
  enabled = true,
) {
  return useQuery({
    queryKey: [command, input],
    queryFn: () => invoke(command, input),
    enabled,
    retry: false,
  });
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试";
}
