import { z } from "zod";

export const focusStateSchema = z
  .object({
    mode: z.enum(["focus", "break"]),
    state: z.enum(["idle", "running", "paused", "completed"]),
    duration: z.number().int().min(60).max(7200),
    remaining: z.number().min(0).max(7200),
    endsAt: z.number().nonnegative().nullable(),
    taskId: z.uuid().nullable(),
    sessions: z.number().int().nonnegative(),
    focusedSeconds: z.number().nonnegative(),
  })
  .strict();
export type FocusState = z.infer<typeof focusStateSchema>;
export const focusCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["start", "pause", "reset"]) }).strict(),
  z
    .object({
      action: z.literal("configure"),
      mode: z.enum(["focus", "break"]),
      minutes: z.number().int().min(1).max(120),
      taskId: z.uuid().nullable(),
    })
    .strict(),
]);
export type FocusCommand = z.infer<typeof focusCommandSchema>;
export function initialFocus(): FocusState {
  return {
    mode: "focus",
    state: "idle",
    duration: 1500,
    remaining: 1500,
    endsAt: null,
    taskId: null,
    sessions: 0,
    focusedSeconds: 0,
  };
}
/**
 * Running timers persist a deadline, not a ticking counter. Recomputing from
 * that deadline accounts for suspended windows, sleep and process restarts.
 * Paused timers use the saved duration instead. Round up so the UI does not
 * display 00:00 before the deadline, and cap clock rollbacks at one full session.
 */
export function remainingFocus(state: FocusState, now: number) {
  return state.state === "running" && state.endsAt !== null
    ? Math.max(
        0,
        Math.min(state.duration, Math.ceil((state.endsAt - now) / 1000)),
      )
    : state.remaining;
}
/**
 * Completion is idempotent: only running -> completed increments the record.
 * The worker persists this result before returning it, so reopening a finished
 * timer or reading it again cannot count the same session twice.
 */
export function settleFocus(state: FocusState, now: number): FocusState {
  if (state.state !== "running" || state.endsAt === null || state.endsAt > now)
    return state;
  return {
    ...state,
    state: "completed",
    remaining: 0,
    endsAt: null,
    sessions: state.sessions + (state.mode === "focus" ? 1 : 0),
    focusedSeconds:
      state.focusedSeconds + (state.mode === "focus" ? state.duration : 0),
  };
}
export function transitionFocus(
  previous: FocusState,
  command: FocusCommand,
  now: number,
): FocusState {
  const state = settleFocus(previous, now);
  // Settle first: a pause/reset arriving just after the deadline must still
  // record the completed interval. Resetting an unfinished interval records none.
  if (command.action === "configure") {
    if (state.state === "running" || state.state === "paused")
      throw new Error("请先结束当前计时，再调整专注设置。");
    return {
      ...state,
      mode: command.mode,
      state: "idle",
      duration: command.minutes * 60,
      remaining: command.minutes * 60,
      endsAt: null,
      taskId: command.taskId,
    };
  }
  if (command.action === "start") {
    if (state.state === "running") return state;
    const remaining =
      state.state === "completed" ? state.duration : state.remaining;
    return {
      ...state,
      state: "running",
      remaining,
      endsAt: now + remaining * 1000,
    };
  }
  if (command.action === "pause" && state.state === "running")
    return {
      ...state,
      state: "paused",
      remaining: remainingFocus(state, now),
      endsAt: null,
    };
  if (command.action === "reset")
    return { ...state, state: "idle", remaining: state.duration, endsAt: null };
  return state;
}
