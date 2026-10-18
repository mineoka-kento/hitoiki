import { afterEach, describe, expect, expectTypeOf, test, vi } from "vite-plus/test";
import { run, wait, type Running, type Task } from "../src/index.ts";
import { fakeClock, flush, manualSchedule, timeoutSchedule } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run", () => {
  test("resolves with the task's return value", async () => {
    function* task() {
      let total = 0;
      for (let i = 1; i <= 1000; i++) {
        total += i;
        yield;
      }
      return total;
    }
    await expect(run(task(), { schedule: timeoutSchedule })).resolves.toBe(500500);
  });

  test("infers the result type", () => {
    function* plain() {
      yield;
      return "a";
    }
    function* waiting(): Task<number> {
      return yield* wait(Promise.resolve(1));
    }
    expectTypeOf(run(plain(), { schedule: timeoutSchedule })).toEqualTypeOf<Running<string>>();
    expectTypeOf(run(waiting(), { schedule: timeoutSchedule })).toEqualTypeOf<Running<number>>();
    expectTypeOf(run(plain(), { schedule: timeoutSchedule })).toExtend<Promise<string>>();
  });

  test("does not start the task synchronously", () => {
    let started = false;
    function* task() {
      started = true;
      yield;
    }
    const { schedule, state } = manualSchedule();
    void run(task(), { schedule });
    expect(started).toBe(false);
    expect(state.calls).toBe(1);
  });

  describe("time slicing", () => {
    /** Each step of this task advances the clock by 1 ms. */
    function* steps(clock: { now: number }, count: number) {
      for (let i = 0; i < count; i++) {
        clock.now += 1;
        yield;
      }
      return "done";
    }

    test("gives control back once the budget is used up", async () => {
      const clock = fakeClock();
      const { schedule, state, tick } = manualSchedule();
      const promise = run(steps(clock, 10), { schedule, budgetMs: 3 });

      const before = clock.now;
      tick();
      expect(clock.now - before).toBe(3); // 3 steps of 1 ms
      expect(state.calls).toBe(2);

      tick();
      tick();
      tick(); // the 10th step and completion
      await expect(promise).resolves.toBe("done");
      expect(state.calls).toBe(4);
    });

    test("caps the slice with the scheduler's hint", () => {
      const clock = fakeClock();
      const { schedule, tick } = manualSchedule();
      void run(steps(clock, 10), { schedule, budgetMs: 5 });

      const before = clock.now;
      tick(2);
      expect(clock.now - before).toBe(2);
    });

    test("never exceeds the budget even when the hint is larger", () => {
      const clock = fakeClock();
      const { schedule, tick } = manualSchedule();
      void run(steps(clock, 100), { schedule, budgetMs: 5 });

      const before = clock.now;
      tick(50);
      expect(clock.now - before).toBe(5);
    });

    test("skips the opportunity when the hint is zero or negative", () => {
      const clock = fakeClock();
      const { schedule, state, tick } = manualSchedule();
      void run(steps(clock, 10), { schedule });

      const before = clock.now;
      tick(0);
      tick(-3);
      expect(clock.now).toBe(before);
      expect(state.calls).toBe(3);
    });

    test("always makes progress, even with a tiny budget", async () => {
      const clock = fakeClock();
      const { schedule, state, tick } = manualSchedule();
      const promise = run(steps(clock, 3), { schedule, budgetMs: 0 });
      while (state.queue.length > 0) tick();
      await expect(promise).resolves.toBe("done");
    });
  });

  describe("waiting for promises", () => {
    test("resumes the task with the resolved value", async () => {
      function* task() {
        const a = yield* wait(Promise.resolve(20));
        const b = yield* wait(new Promise<number>((resolve) => setTimeout(() => resolve(22), 5)));
        return a + b;
      }
      await expect(run(task(), { schedule: timeoutSchedule })).resolves.toBe(42);
    });

    test("resumes through the scheduler, not directly from the promise callback", async () => {
      function* task() {
        return yield* wait(Promise.resolve("value"));
      }
      const { schedule, state, tick } = manualSchedule();
      const promise = run(task(), { schedule });
      tick();
      await flush();
      expect(state.queue).toHaveLength(1);
      tick();
      await expect(promise).resolves.toBe("value");
    });

    test("throws a rejection into the task so it can be caught", async () => {
      function* task() {
        try {
          yield* wait(Promise.reject(new Error("boom")));
          return "not reached";
        } catch (error) {
          return `caught: ${(error as Error).message}`;
        }
      }
      await expect(run(task(), { schedule: timeoutSchedule })).resolves.toBe("caught: boom");
    });

    test("rejects when the rejection is not caught, after running finally", async () => {
      let cleanedUp = false;
      function* task() {
        try {
          yield* wait(Promise.reject(new Error("boom")));
        } finally {
          cleanedUp = true;
        }
      }
      await expect(run(task(), { schedule: timeoutSchedule })).rejects.toThrow("boom");
      expect(cleanedUp).toBe(true);
    });
  });

  describe("errors", () => {
    test("rejects with an error thrown by the task", async () => {
      function* task(): Task<never> {
        yield;
        throw new Error("boom");
      }
      await expect(run(task(), { schedule: timeoutSchedule })).rejects.toThrow("boom");
    });

    test("throws a TypeError into the task when it yields a promise directly", async () => {
      function* task() {
        yield Promise.resolve() as never;
      }
      await expect(run(task(), { schedule: timeoutSchedule })).rejects.toThrow(
        /yield\* wait\(promise\)/,
      );
    });
  });

  describe("abort", () => {
    test("rejects without starting the task when already aborted", async () => {
      let started = false;
      function* task() {
        started = true;
        yield;
      }
      const reason = new Error("aborted");
      const { schedule, state } = manualSchedule();
      await expect(run(task(), { schedule, signal: AbortSignal.abort(reason) })).rejects.toBe(
        reason,
      );
      expect(started).toBe(false);
      expect(state.calls).toBe(0);
    });

    test("rejects immediately between slices, running finally", async () => {
      const clock = fakeClock();
      let cleanedUp = false;
      function* task() {
        try {
          for (;;) {
            clock.now += 1;
            yield;
          }
        } finally {
          cleanedUp = true;
        }
      }
      const controller = new AbortController();
      const { schedule, state, tick } = manualSchedule();
      const promise = run(task(), { schedule, signal: controller.signal, budgetMs: 2 });
      tick();

      controller.abort("stop");
      await expect(promise).rejects.toBe("stop");
      expect(cleanedUp).toBe(true);

      // The slice that was already scheduled does nothing.
      const before = clock.now;
      tick();
      expect(clock.now).toBe(before);
      expect(state.queue).toHaveLength(0);
    });

    test("rejects immediately while waiting for a promise", async () => {
      let cleanedUp = false;
      function* task() {
        try {
          yield* wait(new Promise(() => {})); // never settles
        } finally {
          cleanedUp = true;
        }
      }
      const controller = new AbortController();
      const promise = run(task(), { schedule: timeoutSchedule, signal: controller.signal });
      await flush();

      controller.abort("stop");
      await expect(promise).rejects.toBe("stop");
      expect(cleanedUp).toBe(true);
    });

    test("stops at the next yield when aborted during a slice", async () => {
      const controller = new AbortController();
      let steps = 0;
      let cleanedUp = false;
      function* task() {
        try {
          for (;;) {
            steps++;
            if (steps === 3) controller.abort("stop");
            yield;
          }
        } finally {
          cleanedUp = true;
        }
      }
      const { schedule, tick } = manualSchedule();
      const promise = run(task(), { schedule, signal: controller.signal, budgetMs: Infinity });
      tick();
      await expect(promise).rejects.toBe("stop");
      expect(steps).toBe(3);
      expect(cleanedUp).toBe(true);
    });

    test("rejects with the error when finally throws during abort", async () => {
      function* task() {
        try {
          yield;
        } finally {
          // oxlint-disable-next-line no-unsafe-finally
          throw new Error("cleanup failed");
        }
      }
      const controller = new AbortController();
      const { schedule, tick } = manualSchedule();
      const promise = run(task(), { schedule, signal: controller.signal, budgetMs: 0 });
      tick();
      controller.abort("stop");
      await expect(promise).rejects.toThrow("cleanup failed");
    });

    test("removes the abort listener once settled", async () => {
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      function* task() {
        yield;
        return 1;
      }
      await run(task(), { schedule: timeoutSchedule, signal: controller.signal });
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    });
  });
});
