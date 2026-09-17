import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  Bridge,
  Command,
  Inputs,
  Outputs,
  Result,
} from "../shared/contract";

const bridge: Bridge = {
  async invoke<K extends Command>(
    command: K,
    input: Inputs[K],
  ): Promise<Outputs[K]> {
    const result = (await ipcRenderer.invoke(
      "tasklink:invoke",
      command,
      input,
    )) as Result<Outputs[K]>;
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  },
  subscribe(listener) {
    const callback = (_event: unknown, dataChanged: boolean) =>
      listener(dataChanged !== false);
    ipcRenderer.on("tasklink:changed", callback);
    return () => ipcRenderer.removeListener("tasklink:changed", callback);
  },
  async stageFiles(files, peer_id) {
    if (!Array.isArray(files) || !files.length || files.length > 5)
      throw new Error("每次最多选择 5 个文件");
    const paths = files.map((file) => {
      const value = webUtils.getPathForFile(file);
      if (!value) throw new Error("请拖入或选择磁盘上的实际文件");
      return value;
    });
    const result = (await ipcRenderer.invoke(
      "tasklink:stage-files",
      paths,
      peer_id,
    )) as Result<Awaited<ReturnType<Bridge["stageFiles"]>>>;
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  },
  onChatPeer(listener) {
    const callback = (_event: unknown, peer_id: string) => listener(peer_id);
    ipcRenderer.on("tasklink:chat-peer", callback);
    return () => ipcRenderer.removeListener("tasklink:chat-peer", callback);
  },
  onTransfer(listener) {
    const callback = (
      _event: unknown,
      progress: Parameters<typeof listener>[0],
    ) => listener(progress);
    ipcRenderer.on("tasklink:transfer", callback);
    return () => ipcRenderer.removeListener("tasklink:transfer", callback);
  },
};
contextBridge.exposeInMainWorld("tasklink", Object.freeze(bridge));
