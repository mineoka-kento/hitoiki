import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from "vite-plus/test";
import type { Priority } from "../src/index.ts";

test("Priority stays identical to the DOM's TaskPriority", () => {
  // Checked by `vp check`. If the Prioritized Task Scheduling API adds, removes or renames
  // a priority, this fails and `Priority` in src/schedule.ts must be updated.
  expectTypeOf<Priority>().toEqualTypeOf<TaskPriority>();
});

/** Loads a fresh copy of the module so that module-level state does not leak between tests. */
async function load() {
  vi.resetModules();
  return import("../src/schedule.ts");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Removes the scheduling APIs Node.js does not have anyway, to make each test explicit. */
function stubNoBrowserApis() {
  vi.stubGlobal("scheduler", undefined);
  vi.stubGlobal("Scheduler", undefined);
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.stubGlobal("requestAnimationFrame", undefined);
}

describe("createSchedule", () => {
  describe("native scheduler.postTask", () => {
    function stubNativeScheduler() {
      const postTask = vi.fn((callback: () => void, _options?: { priority?: string }) => {
        callback();
        return Promise.resolve();
      });
      class FakeScheduler {
        postTask = postTask;
      }
      stubNoBrowserApis();
      vi.stubGlobal("Scheduler", FakeScheduler);
      vi.stubGlobal("scheduler", new FakeScheduler());
      return postTask;
    }

    test.each(["background", "user-visible", "user-blocking"] as const)(
      "posts tasks with priority %s",
      async (priority) => {
        const postTask = stubNativeScheduler();
        const { createSchedule } = await load();
        const resume = vi.fn();
        createSchedule(priority)(resume);
        expect(postTask).toHaveBeenCalledWith(expect.any(Function), { priority });
        expect(resume).toHaveBeenCalledWith(); // no hint
      },
    );

    test("defaults to background", async () => {
      const postTask = stubNativeScheduler();
      const { createSchedule } = await load();
      createSchedule()(vi.fn());
      expect(postTask).toHaveBeenCalledWith(expect.any(Function), { priority: "background" });
    });

    test("ignores a polyfilled scheduler (no native Scheduler class)", async () => {
      stubNoBrowserApis();
      const postTask = vi.fn();
      vi.stubGlobal("scheduler", { postTask });
      const { getNativeScheduler } = await load();
      expect(getNativeScheduler()).toBeUndefined();
    });
  });

  describe("without native postTask", () => {
    test("user-visible and user-blocking use a macrotask", async () => {
      stubNoBrowserApis();
      const idle = vi.fn();
      vi.stubGlobal("requestIdleCallback", idle);
      const { createSchedule } = await load();
      for (const priority of ["user-visible", "user-blocking"] as const) {
        const resume = vi.fn();
        createSchedule(priority)(resume);
        expect(resume).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(resume).toHaveBeenCalledWith());
      }
      expect(idle).not.toHaveBeenCalled();
    });

    test("background uses requestIdleCallback with a timeout and passes the deadline", async () => {
      stubNoBrowserApis();
      const idle = vi.fn(
        (callback: IdleRequestCallback, _options?: IdleRequestOptions) => (
          callback({ didTimeout: false, timeRemaining: () => 3.5 }),
          1
        ),
      );
      vi.stubGlobal("requestIdleCallback", idle);
      const { createSchedule } = await load();
      const resume = vi.fn();
      createSchedule("background", { idleTimeoutMs: 500 })(resume);
      expect(idle).toHaveBeenCalledWith(expect.any(Function), { timeout: 500 });
      expect(resume).toHaveBeenCalledWith(3.5);
    });

    test("background uses a short slice when the idle callback timed out", async () => {
      stubNoBrowserApis();
      vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
        callback({ didTimeout: true, timeRemaining: () => 0 });
        return 1;
      });
      const { createSchedule } = await load();
      const resume = vi.fn();
      createSchedule("background")(resume);
      expect(resume).toHaveBeenCalledWith(1);
    });

    test("background falls back to one slice after each frame, sized to the time left", async () => {
      stubNoBrowserApis();
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
      const now = vi.spyOn(performance, "now");
      const { createSchedule } = await load();
      const schedule = createSchedule("background");

      // 60 Hz by default: frame at 1000 ms, now 1003 ms -> 1000 + 16.67 - 1003 - 2 (safety)
      const first = vi.fn();
      schedule(first);
      now.mockReturnValue(1003);
      frames.shift()!(1000);
      await vi.waitFor(() => expect(first).toHaveBeenCalled());
      expect(first.mock.calls[0]![0]).toBeCloseTo(1000 / 60 - 3 - 2);

      // A frame 8.33 ms later reveals a 120 Hz display.
      const second = vi.fn();
      schedule(second);
      now.mockReturnValue(1009.33);
      frames.shift()!(1008.33);
      await vi.waitFor(() => expect(second).toHaveBeenCalled());
      expect(second.mock.calls[0]![0]).toBeCloseTo(8.33 - 1 - 2);
    });

    test("falls back to a macrotask when no browser scheduling API exists", async () => {
      stubNoBrowserApis();
      const { createSchedule } = await load();
      const resume = vi.fn();
      createSchedule("background")(resume);
      await vi.waitFor(() => expect(resume).toHaveBeenCalledWith());
    });
  });
});
