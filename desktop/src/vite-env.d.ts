import type { Bridge } from "../shared/contract";
declare global {
  interface Window {
    tasklink?: Bridge;
  }
}
export {};
