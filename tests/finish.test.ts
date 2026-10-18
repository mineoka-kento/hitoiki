import { afterEach, describe, expect, expectTypeOf, test, vi } from "vite-plus/test";
import {
  run,
  TaskWaitingError,
  wait,
  type Running,
  type Task,
  type TryFinishResult,
} from "../src/index.ts";
import { fakeClock, flush, manualSchedule, timeoutSchedule } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Each step of this task advances the clock by 1 ms. */
function* steps(clock: { now: number }, count: number) {
  let done = 0;
  for (let i = 0; i < count; i++) {
    clock.now += 1;
    done++;
    yield;
  }
  return done;
}

describe("tryFinish", () => {
  test("returns the result when the task completes within the budget", async () => {
    const clock = fakeClock();
    const { schedule, state, tick } = manualSchedule();
    const running = run(steps(clock, 3), { schedule });

    expect(running.tryFinish(10)).toEqual({ done: true, value: 3 });
    await expect(running).resolves.toBe(3);

    // The slice that was scheduled when the task started does nothing.
    const before = clock.now;
    tick();
    expect(clock.now).toBe(before);
    expect(state.calls).toBe(1);
  });

  test("returns { done: false } when the budget runs out, and the task keeps running", async () => {
    const clock = fakeClock();
    const { schedule, state, tick } = manualSchedule();
    const running = run(steps(clock, 10), { schedule, budgetMs: 100 });

    const before = clock.now;
    expect(running.tryFinish(4)).toEqual({ done: false });
    expect(clock.now - before).toBe(4);
    expect(state.calls).toBe(1); // the pending slice is reused, not scheduled twice

    tick();
    await expect(running).resolves.toBe(10);
  });

  test("defaults to the budget given to run()", () => {
    const clock = fakeClock();
    const { schedule } = manualSchedule();
    const running = run(steps(clock, 10), { schedule, budgetMs: 3 });

    const before = clock.now;
    running.tryFinish();
    expect(clock.now - before).toBe(3);
  });

  test("schedules the continuation if no slice is pending", async () => {
    const clock = fakeClock();
    const { schedule, state, tick } = manualSchedule();
    const running = run(steps(clock, 10), { schedule, budgetMs: 2 });
    tick(); // runs 2 steps and schedules the next slice
    tick(); // runs 2 steps and schedules the next slice
    expect(state.calls).toBe(3);

    running.tryFinish(2);
    expect(state.queue).toHaveLength(1);
    while (state.queue.length > 0) tick();
    await expect(running).resolves.toBe(10);
  });

  test("always makes progress, even with a zero budget", () => {
    const clock = fakeClock();
    const { schedule } = manualSchedule();
    const running = run(steps(clock, 10), { schedule });

    const before = clock.now;
    running.tryFinish(0);
    expect(clock.now - before).toBe(1);
  });

  test("returns { done: false } when the task starts waiting for a promise", async () => {
    function* task() {
      yield;
      const value = yield* wait(Promise.resolve(41));
      return value + 1;
    }
    const running = run(task(), { schedule: timeoutSchedule });
    expect(running.tryFinish(100)).toEqual({ done: false });
    await expect(running).resolves.toBe(42);
  });

  test("returns { done: false } without running while the task is waiting", async () => {
    let afterWait = false;
    let release!: () => void;
    function* task() {
      yield* wait(new Promise<void>((resolve) => (release = resolve)));
      afterWait = true;
      return "done";
    }
    const { schedule, tick } = manualSchedule();
    const running = run(task(), { schedule });
    tick();

    expect(running.tryFinish(100)).toEqual({ done: false });
    expect(afterWait).toBe(false);

    release();
    await flush();
    expect(running.tryFinish(100)).toEqual({ done: true, value: "done" });
  });

  test("keeps returning the result after the task has completed", async () => {
    function* task() {
      yield;
      return "value";
    }
    const running = run(task(), { schedule: timeoutSchedule });
    await running;
    expect(running.tryFinish()).toEqual({ done: true, value: "value" });
    expect(running.tryFinish()).toEqual({ done: true, value: "value" });
  });

  test("throws the task's error synchronously", async () => {
    function* task(): Task<never> {
      yield;
      throw new Error("boom");
    }
    const running = run(task(), { schedule: timeoutSchedule });
    expect(() => running.tryFinish(100)).toThrow("boom");
    await expect(running).rejects.toThrow("boom");
  });

  test("infers the result type", () => {
    const { schedule } = manualSchedule();
    const running = run(steps({ now: 0 }, 1), { schedule });
    expectTypeOf(running.tryFinish()).toEqualTypeOf<TryFinishResult<number>>();
    const result = running.tryFinish();
    if (result.done) expectTypeOf(result.value).toEqualTypeOf<number>();
  });
});

describe("finish", () => {
  test("runs the task to completion synchronously, without a time limit", async () => {
    const clock = fakeClock();
    const { schedule, state, tick } = manualSchedule();
    const running = run(steps(clock, 1000), { schedule, budgetMs: 5 });

    expect(running.finish()).toBe(1000);
    await expect(running).resolves.toBe(1000);

    tick(); // the pending slice does nothing
    expect(state.calls).toBe(1);
  });

  test("finishes a task that has already run some slices", async () => {
    const clock = fakeClock();
    const { schedule, tick } = manualSchedule();
    const running = run(steps(clock, 10), { schedule, budgetMs: 3 });
    tick();
    expect(running.tryFinish(3)).toEqual({ done: false });

    expect(running.finish()).toBe(10);
    await expect(running).resolves.toBe(10);
  });

  test("throws TaskWaitingError when the task waits for a promise, and the task keeps running", async () => {
    let cleanedUp = false;
    function* task() {
      try {
        yield;
        const value = yield* wait(Promise.resolve(41));
        return value + 1;
      } finally {
        cleanedUp = true;
      }
    }
    const running = run(task(), { schedule: timeoutSchedule });

    expect(() => running.finish()).toThrow(TaskWaitingError);
    expect(cleanedUp).toBe(false);
    await expect(running).resolves.toBe(42);
  });

  test("throws TaskWaitingError while the task is waiting", async () => {
    let release!: () => void;
    function* task() {
      yield* wait(new Promise<void>((resolve) => (release = resolve)));
      return "done";
    }
    const { schedule, tick } = manualSchedule();
    const running = run(task(), { schedule });
    tick();

    expect(() => running.finish()).toThrow(TaskWaitingError);

    release();
    await flush();
    expect(running.finish()).toBe("done");
  });

  test("throws the task's error synchronously", async () => {
    function* task(): Task<never> {
      yield;
      throw new Error("boom");
    }
    const running = run(task(), { schedule: timeoutSchedule });
    expect(() => running.finish()).toThrow("boom");
    await expect(running).rejects.toThrow("boom");
  });

  test("throws the abort reason after the task was aborted", async () => {
    const controller = new AbortController();
    const { schedule } = manualSchedule();
    const running = run(steps({ now: 0 }, 10), { schedule, signal: controller.signal });
    controller.abort("stop");

    expect(() => running.finish()).toThrow("stop");
    await expect(running).rejects.toBe("stop");
  });

  test("stops when the task aborts itself during finish(), running finally", () => {
    const controller = new AbortController();
    let cleanedUp = false;
    function* task() {
      try {
        for (let i = 0; ; i++) {
          if (i === 5) controller.abort("stop");
          yield;
        }
      } finally {
        cleanedUp = true;
      }
    }
    const { schedule } = manualSchedule();
    const running = run(task(), { schedule, signal: controller.signal });

    expect(() => running.finish()).toThrow("stop");
    expect(cleanedUp).toBe(true);
  });

  test("cannot be called from inside the task", async () => {
    const holder: { running?: Running<string> } = {};
    function* task() {
      yield;
      try {
        holder.running!.finish();
        return "not reached";
      } catch (error) {
        return (error as Error).message;
      }
    }
    holder.running = run(task(), { schedule: timeoutSchedule });
    await expect(holder.running).resolves.toMatch(/inside the task/);
  });

  test("does not report an unhandled rejection when the error was received synchronously", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      function* task(): Task<never> {
        yield;
        throw new Error("boom");
      }
      const running = run(task(), { schedule: timeoutSchedule });
      expect(() => running.finish()).toThrow("boom");
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  test("infers the result type", () => {
    const { schedule } = manualSchedule();
    const running = run(steps({ now: 0 }, 1), { schedule });
    expectTypeOf(running.finish).returns.toEqualTypeOf<number>();
  });
});
