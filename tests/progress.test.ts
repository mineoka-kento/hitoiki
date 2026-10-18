import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import { run, wait, type Running, type Task } from "../src/index.ts";
import { flush, manualSchedule, timeoutSchedule } from "./helpers.ts";

interface Progress {
  done: number;
  total: number;
}

describe("progress", () => {
  describe("types", () => {
    test("infers the progress type from the yielded values", () => {
      function* task() {
        for (let i = 0; i < 10; i++) {
          yield { done: i, total: 10 };
        }
        return "result";
      }
      const running = run(task(), { schedule: timeoutSchedule });
      expectTypeOf(running).toEqualTypeOf<Running<string, { done: number; total: number }>>();
      expectTypeOf(running.progress).toEqualTypeOf<{ done: number; total: number } | undefined>();
    });

    test("ignores bare yields and wait() when inferring", () => {
      function* task() {
        yield;
        const n = yield* wait(Promise.resolve(1));
        yield n / 2;
        return n;
      }
      expectTypeOf(run(task(), { schedule: timeoutSchedule })).toEqualTypeOf<
        Running<number, number>
      >();
    });

    test("is never when the task reports no progress", () => {
      function* task() {
        yield;
        yield* wait(Promise.resolve());
        return 1;
      }
      const running = run(task(), { schedule: timeoutSchedule });
      expectTypeOf(running).toEqualTypeOf<Running<number, never>>();
      expectTypeOf(running.progress).toEqualTypeOf<undefined>();
    });

    test("follows an explicit Task annotation", () => {
      function* task(): Task<string, Progress> {
        yield { done: 1, total: 2 };
        yield;
        return "result";
      }
      expectTypeOf(run(task(), { schedule: timeoutSchedule })).toEqualTypeOf<
        Running<string, Progress>
      >();
    });

    test("rejects values that do not match an explicit Task annotation", () => {
      function* task(): Task<string, Progress> {
        // @ts-expect-error A string is not a `Progress`.
        yield "half";
        return "result";
      }
      expectTypeOf(task).toBeFunction();
    });

    test("combines the progress of delegated tasks", () => {
      function* load() {
        yield "loading" as const;
        return yield* wait(Promise.resolve([1, 2, 3]));
      }
      function* task() {
        const items = yield* load();
        for (let i = 0; i < items.length; i++) yield i / items.length;
        return items.length;
      }
      expectTypeOf(run(task(), { schedule: timeoutSchedule }).progress).toEqualTypeOf<
        "loading" | number | undefined
      >();
    });

    test("rejects yielding a promise directly", () => {
      function* task() {
        yield Promise.resolve(1);
      }
      // @ts-expect-error Use `yield* wait(promise)` instead of yielding a promise.
      void run(task(), { schedule: timeoutSchedule }).catch(() => {});
    });

    test("widens literal values, like function return types", () => {
      function* task() {
        yield "loading";
        yield 1;
        return true;
      }
      expectTypeOf(run(task(), { schedule: timeoutSchedule }).progress).toEqualTypeOf<
        string | number | undefined
      >();
    });

    test("keeps literal types with `as const`, e.g. for discriminated unions", () => {
      function* task() {
        yield { phase: "loading" } as const;
        for (let i = 0; i < 3; i++) yield { phase: "drawing", done: i, total: 3 } as const;
        return "result";
      }
      // TypeScript normalizes unions of object literals (it adds `done?: undefined` to the
      // "loading" member), so compare with the generator's own yield type.
      type Yielded = ReturnType<typeof task> extends Generator<infer Y> ? Y : never;
      const progress = run(task(), { schedule: timeoutSchedule }).progress;
      expectTypeOf(progress).toEqualTypeOf<Yielded | undefined>();
      expectTypeOf<NonNullable<typeof progress>["phase"]>().toEqualTypeOf<"loading" | "drawing">();
      if (progress?.phase === "drawing") {
        expectTypeOf(progress.done).toEqualTypeOf<number>();
        expectTypeOf(progress.total).toEqualTypeOf<3>();
      }
    });

    test("excludes undefined from the progress type, but keeps null", () => {
      function* task(values: Array<number | undefined>) {
        for (const value of values) yield value; // `undefined` means "no new progress"
        yield null; // a value of the user's choosing, e.g. to clear the progress
        return values.length;
      }
      const running = run(task([1, undefined]), { schedule: timeoutSchedule });
      expectTypeOf(running).toEqualTypeOf<Running<number, number | null>>();
      expectTypeOf(running.progress).toEqualTypeOf<number | null | undefined>();
    });

    test("flows into state and subscribe()", () => {
      function* task() {
        yield { done: 1, total: 2 };
        return "result";
      }
      const running = run(task(), { schedule: timeoutSchedule });
      expectTypeOf(running.state.progress).toEqualTypeOf<Progress | undefined>();
      running.subscribe((state) => {
        expectTypeOf(state.progress).toEqualTypeOf<Progress | undefined>();
        if (state.status === "fulfilled") expectTypeOf(state.value).toEqualTypeOf<string>();
      });
    });

    test("Running and Task default to no progress", () => {
      expectTypeOf<Running<string>>().toEqualTypeOf<Running<string, never>>();
      expectTypeOf<Running<string>["progress"]>().toEqualTypeOf<undefined>();
      function* task(): Task<number> {
        yield;
        // @ts-expect-error `Task<number>` reports no progress.
        yield 1;
        return 1;
      }
      expectTypeOf(run(task(), { schedule: timeoutSchedule })).toEqualTypeOf<Running<number>>();
    });

    test("rejects delegating to a task with incompatible progress", () => {
      function* load() {
        yield "loading";
        return [1, 2, 3];
      }
      function* task(): Task<number, Progress> {
        // @ts-expect-error `load()` yields strings, which are not a `Progress`.
        const items = yield* load();
        return items.length;
      }
      expectTypeOf(task).toBeFunction();
    });

    test("works through generic helpers", () => {
      /** A reusable helper that only yields pause points. */
      function* chunk<T>(items: readonly T[], size: number) {
        const chunks: T[][] = [];
        for (let i = 0; i < items.length; i += size) {
          chunks.push(items.slice(i, i + size));
          yield;
        }
        return chunks;
      }
      /** A reusable helper that reports progress of a type chosen by the caller. */
      function* report<P>(progress: P) {
        yield progress;
      }
      function* task() {
        const chunks = yield* chunk(["a", "b", "c"], 2);
        expectTypeOf(chunks).toEqualTypeOf<string[][]>();
        yield* report({ done: chunks.length, total: chunks.length });
        return chunks;
      }
      expectTypeOf(run(task(), { schedule: timeoutSchedule })).toEqualTypeOf<
        Running<string[][], { done: number; total: number }>
      >();
    });
  });

  describe("values", () => {
    function* counting(total: number) {
      for (let done = 1; done <= total; done++) {
        yield { done, total };
      }
      return "result";
    }

    test("is undefined before the task yields a progress value", () => {
      const { schedule } = manualSchedule();
      const running = run(counting(3), { schedule });
      expect(running.progress).toBeUndefined();
    });

    test("holds the latest value yielded in a slice", () => {
      const { schedule, tick } = manualSchedule();
      const running = run(counting(10), { schedule, budgetMs: 0 }); // one step per slice
      tick();
      expect(running.progress).toEqual({ done: 1, total: 10 });
      tick();
      tick();
      expect(running.progress).toEqual({ done: 3, total: 10 });
    });

    test("is updated by tryFinish() and finish()", () => {
      const { schedule } = manualSchedule();
      const running = run(counting(10), { schedule });
      running.tryFinish(0);
      expect(running.progress).toEqual({ done: 1, total: 10 });
      running.finish();
      expect(running.progress).toEqual({ done: 10, total: 10 });
    });

    test("is not changed by a bare yield", () => {
      function* task() {
        yield 0.5;
        yield;
        yield;
        return "result";
      }
      const { schedule, tick } = manualSchedule();
      const running = run(task(), { schedule, budgetMs: 0 });
      tick();
      tick();
      tick();
      expect(running.progress).toBe(0.5);
    });

    test("keeps its last value after the task completes", async () => {
      const running = run(counting(5), { schedule: timeoutSchedule });
      await running;
      expect(running.progress).toEqual({ done: 5, total: 5 });
    });

    test("can be read while the task is waiting for a promise", async () => {
      let release!: (value: number) => void;
      function* task() {
        yield "loading";
        const n = yield* wait(new Promise<number>((resolve) => (release = resolve)));
        yield "processing";
        return n;
      }
      const { schedule, tick } = manualSchedule();
      const running = run(task(), { schedule });
      tick();
      expect(running.progress).toBe("loading");

      release(7);
      await flush();
      tick();
      await expect(running).resolves.toBe(7);
      expect(running.progress).toBe("processing");
    });

    test("includes values yielded by delegated tasks", () => {
      function* inner() {
        yield "inner";
        return 1;
      }
      function* outer() {
        const n = yield* inner();
        return n + 1;
      }
      const { schedule } = manualSchedule();
      const running = run(outer(), { schedule, budgetMs: 0 });
      running.tryFinish(0);
      expect(running.progress).toBe("inner");
    });

    test("accepts falsy progress values", () => {
      function* task() {
        yield 1;
        yield 0;
        return "result";
      }
      const { schedule } = manualSchedule();
      const running = run(task(), { schedule });
      running.finish();
      expect(running.progress).toBe(0);
    });

    test("is a live property, also after destructuring the methods", () => {
      const { schedule } = manualSchedule();
      const running = run(counting(3), { schedule });
      const { finish } = running;
      finish();
      expect(running.progress).toEqual({ done: 3, total: 3 });
    });
  });
});
