import { afterEach, describe, expect, expectTypeOf, test, vi } from "vite-plus/test";
import { run, wait, type TaskState, type Task } from "../src/index.ts";
import { flush, manualSchedule, timeoutSchedule } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function* counting(total: number) {
  for (let done = 1; done <= total; done++) {
    yield done;
  }
  return "result";
}

describe("state", () => {
  test("is running with no progress before the task starts", () => {
    const { schedule } = manualSchedule();
    const running = run(counting(3), { schedule });
    expect(running.state).toEqual({ status: "running", progress: undefined });
  });

  test("is running with the latest progress while the task runs", () => {
    const { schedule, tick } = manualSchedule();
    const running = run(counting(10), { schedule, budgetMs: 0 });
    tick();
    tick();
    expect(running.state).toEqual({ status: "running", progress: 2 });
  });

  test("is running while the task waits for a promise", () => {
    function* task() {
      yield "loading";
      return yield* wait(new Promise<number>(() => {}));
    }
    const { schedule, tick } = manualSchedule();
    const running = run(task(), { schedule });
    tick();
    expect(running.state).toEqual({ status: "running", progress: "loading" });
  });

  test("is fulfilled with the value and the last progress", async () => {
    const running = run(counting(3), { schedule: timeoutSchedule });
    await running;
    expect(running.state).toEqual({ status: "fulfilled", value: "result", progress: 3 });
  });

  test("is rejected with the reason and the last progress", async () => {
    const error = new Error("boom");
    function* task(): Task<never, number> {
      yield 60;
      throw error;
    }
    const running = run(task(), { schedule: timeoutSchedule });
    await expect(running).rejects.toBe(error);
    expect(running.state).toEqual({ status: "rejected", reason: error, progress: 60 });
  });

  test("is rejected with the abort reason when aborted", async () => {
    const controller = new AbortController();
    const { schedule, tick } = manualSchedule();
    const running = run(counting(10), { schedule, signal: controller.signal, budgetMs: 0 });
    tick();
    controller.abort("stop");
    await expect(running).rejects.toBe("stop");
    expect(running.state).toEqual({ status: "rejected", reason: "stop", progress: 1 });
  });

  test("returns the same object until the state changes", () => {
    function* task() {
      yield 1;
      yield;
      yield 1; // same value as before: not a change
      yield 2;
      return "result";
    }
    const { schedule, tick } = manualSchedule();
    const running = run(task(), { schedule, budgetMs: 0 });
    const initial = running.state;
    expect(running.state).toBe(initial);

    tick(); // progress 1
    const first = running.state;
    expect(first).not.toBe(initial);
    tick(); // bare yield
    tick(); // progress 1 again
    expect(running.state).toBe(first);
    tick(); // progress 2
    expect(running.state).not.toBe(first);
  });

  test("progress is a shortcut for state.progress", () => {
    const { schedule } = manualSchedule();
    const running = run(counting(3), { schedule });
    running.tryFinish(0);
    expect(running.progress).toBe(running.state.progress);
  });

  test("narrows by status", () => {
    const { schedule } = manualSchedule();
    const running = run(counting(1), { schedule });
    const state = running.state;
    expectTypeOf(state).toEqualTypeOf<TaskState<string, number>>();
    if (state.status === "fulfilled") expectTypeOf(state.value).toEqualTypeOf<string>();
    if (state.status === "rejected") expectTypeOf(state.reason).toEqualTypeOf<unknown>();
    expectTypeOf(state.progress).toEqualTypeOf<number | undefined>();
    // @ts-expect-error `value` exists only when fulfilled.
    void state.value;
  });

  test("reading it has no side effects", () => {
    const { schedule, state: scheduled } = manualSchedule();
    let steps = 0;
    function* task() {
      steps++;
      yield;
    }
    const running = run(task(), { schedule });
    expect(running.state.status).toBe("running");
    expect(running.progress).toBeUndefined();
    expect(steps).toBe(0);
    expect(scheduled.calls).toBe(1);
  });
});

describe("subscribe", () => {
  test("notifies once per slice, however many progress values were yielded", () => {
    const { schedule, tick } = manualSchedule();
    const running = run(counting(100), { schedule, budgetMs: Infinity });
    const listener = vi.fn();
    running.subscribe(listener);

    running.tryFinish(0); // one step
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ status: "running", progress: 1 });

    tick(); // the rest of the task in one slice
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      status: "fulfilled",
      value: "result",
      progress: 100,
    });
  });

  test("passes the same object as state", () => {
    const { schedule, tick } = manualSchedule();
    const running = run(counting(3), { schedule, budgetMs: 0 });
    const received: unknown[] = [];
    running.subscribe((state) => received.push(state));
    tick();
    expect(received[0]).toBe(running.state);
  });

  test("does not notify when a slice changed nothing", () => {
    function* task() {
      yield 1;
      for (let i = 0; i < 10; i++) yield;
      return "result";
    }
    const { schedule, tick } = manualSchedule();
    const running = run(task(), { schedule, budgetMs: 0 });
    const listener = vi.fn();
    running.subscribe(listener);
    tick();
    tick();
    tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("notifies completion, failure and abort", async () => {
    const fulfilled = vi.fn();
    const ok = run(counting(2), { schedule: timeoutSchedule });
    ok.subscribe(fulfilled);
    await ok;
    expect(fulfilled).toHaveBeenLastCalledWith(expect.objectContaining({ status: "fulfilled" }));

    function* failing(): Task<never> {
      yield;
      throw new Error("boom");
    }
    const rejected = vi.fn();
    const ng = run(failing(), { schedule: timeoutSchedule });
    ng.subscribe(rejected);
    await ng.catch(() => {});
    expect(rejected).toHaveBeenLastCalledWith(expect.objectContaining({ status: "rejected" }));

    const aborted = vi.fn();
    const controller = new AbortController();
    const { schedule } = manualSchedule();
    const cancelled = run(counting(5), { schedule, signal: controller.signal });
    cancelled.subscribe(aborted);
    controller.abort("stop");
    expect(aborted).toHaveBeenCalledTimes(1); // synchronously, without waiting for a slice
    expect(aborted).toHaveBeenLastCalledWith({
      status: "rejected",
      reason: "stop",
      progress: undefined,
    });
    await cancelled.catch(() => {});
  });

  test("notifies an abort while the task waits for a promise", async () => {
    const controller = new AbortController();
    function* task() {
      yield "loading";
      yield* wait(new Promise(() => {}));
    }
    const running = run(task(), { schedule: timeoutSchedule, signal: controller.signal });
    await flush();
    const listener = vi.fn();
    running.subscribe(listener);
    controller.abort("stop");
    expect(listener).toHaveBeenCalledWith({
      status: "rejected",
      reason: "stop",
      progress: "loading",
    });
    await running.catch(() => {});
  });

  test("notifies once for finish()", () => {
    const { schedule } = manualSchedule();
    const running = run(counting(1000), { schedule });
    const listener = vi.fn();
    running.subscribe(listener);
    running.finish();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ status: "fulfilled", value: "result", progress: 1000 });
  });

  test("stops notifying after unsubscribing", () => {
    const { schedule, tick } = manualSchedule();
    const running = run(counting(10), { schedule, budgetMs: 0 });
    const listener = vi.fn();
    const unsubscribe = running.subscribe(listener);
    tick();
    unsubscribe();
    tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("does nothing when subscribing after the task has ended", async () => {
    const running = run(counting(1), { schedule: timeoutSchedule });
    await running;
    const listener = vi.fn();
    const unsubscribe = running.subscribe(listener);
    expect(() => unsubscribe()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  test("reports a listener's error without stopping the task or other listeners", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const error = new Error("listener failed");
    const running = run(counting(3), { schedule: timeoutSchedule });
    running.subscribe(() => {
      throw error;
    });
    const other = vi.fn();
    running.subscribe(other);

    await expect(running).resolves.toBe("result");
    expect(reportError).toHaveBeenCalledWith(error);
    expect(other).toHaveBeenCalled();
  });

  test("lets a listener finish the task", async () => {
    const { schedule, state, tick } = manualSchedule();
    const running = run(counting(10), { schedule, budgetMs: 0 });
    const results: string[] = [];
    running.subscribe((s) => {
      if (s.status === "running" && s.progress === 2) results.push(running.finish());
    });
    tick();
    tick();
    expect(results).toEqual(["result"]);
    await expect(running).resolves.toBe("result");
    expect(running.state.status).toBe("fulfilled");
    while (state.queue.length > 0) tick(); // leftover slices do nothing
    expect(running.progress).toBe(10);
  });

  test("works with the useSyncExternalStore contract", () => {
    // useSyncExternalStore requires getSnapshot to return the same value until subscribers
    // are notified, and a different value after.
    const { schedule, tick } = manualSchedule();
    const running = run(counting(5), { schedule, budgetMs: 0 });
    const getSnapshot = () => running.state;
    let snapshot = getSnapshot();
    let mismatches = 0;
    running.subscribe(() => {
      const nextSnapshot = getSnapshot();
      if (nextSnapshot === snapshot) mismatches++;
      snapshot = nextSnapshot;
    });
    for (let i = 0; i < 6; i++) {
      tick();
      expect(getSnapshot()).toBe(snapshot);
    }
    expect(mismatches).toBe(0);
    expect(snapshot.status).toBe("fulfilled");
  });
});
