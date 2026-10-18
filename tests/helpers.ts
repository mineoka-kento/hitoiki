import { vi } from "vite-plus/test";
import type { Resume, Schedule } from "../src/index.ts";

/** A scheduler that only runs slices when the test asks it to. */
export function manualSchedule() {
  const state = { calls: 0, queue: [] as Resume[] };
  const schedule: Schedule = (resume) => {
    state.calls++;
    state.queue.push(resume);
  };
  /** Runs the oldest pending slice. */
  const tick = (hintMs?: number) => {
    const resume = state.queue.shift();
    if (!resume) throw new Error("no slice is scheduled");
    resume(hintMs);
  };
  return { schedule, state, tick };
}

/** A scheduler that runs each slice in a new macrotask. */
export const timeoutSchedule: Schedule = (resume) => {
  setTimeout(() => resume(), 0);
};

/** Waits until pending promise callbacks and timers have run. */
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Replaces `performance.now()` with a clock the test controls. */
export function fakeClock(start = 1000) {
  const clock = { now: start };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  return clock;
}
