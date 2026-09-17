import { describe, expect, it } from "vitest";
import {
  initialFocus,
  remainingFocus,
  settleFocus,
  transitionFocus,
} from "../shared/focus";
describe("persistent focus timer", () => {
  it("uses an absolute deadline so sleep/restart does not slow the timer", () => {
    const state = transitionFocus(initialFocus(), { action: "start" }, 10000);
    expect(remainingFocus(state, 70000)).toBe(1440);
    expect(remainingFocus(JSON.parse(JSON.stringify(state)), 110000)).toBe(
      1400,
    );
  });
  it("pauses, resumes remaining time and ignores duplicate start clicks", () => {
    const running = transitionFocus(initialFocus(), { action: "start" }, 0);
    expect(transitionFocus(running, { action: "start" }, 10000)).toEqual(
      running,
    );
    const paused = transitionFocus(running, { action: "pause" }, 60000);
    expect(paused.remaining).toBe(1440);
    expect(remainingFocus(paused, 999999)).toBe(1440);
    expect(transitionFocus(paused, { action: "start" }, 100000).endsAt).toBe(
      1540000,
    );
  });
  it("records a completed interval only once", () => {
    const running = transitionFocus(initialFocus(), { action: "start" }, 0);
    const completed = settleFocus(running, 1500000);
    expect(completed.sessions).toBe(1);
    expect(completed.focusedSeconds).toBe(1500);
    expect(settleFocus(completed, 9999999)).toEqual(completed);
  });
  it("does not count breaks or abandoned intervals as completed focus", () => {
    const idle = transitionFocus(
      initialFocus(),
      { action: "configure", mode: "break", minutes: 5, taskId: null },
      0,
    );
    const running = transitionFocus(idle, { action: "start" }, 0);
    expect(settleFocus(running, 300000).sessions).toBe(0);
    expect(
      transitionFocus(running, { action: "reset" }, 100000).focusedSeconds,
    ).toBe(0);
  });
  it("requires ending active work before replacing its configuration", () => {
    const running = transitionFocus(initialFocus(), { action: "start" }, 0);
    expect(() =>
      transitionFocus(
        running,
        { action: "configure", mode: "focus", minutes: 45, taskId: null },
        100,
      ),
    ).toThrow();
  });
});
