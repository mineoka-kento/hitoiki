// This is the same as the DOM's `TaskPriority`, but defined here on purpose: the published
// type definitions must not depend on `TaskPriority`, which TypeScript < 6.0 and projects
// without DOM types do not have (it would become an error, or silently `any`).
// tests/schedule.test.ts checks that the two stay identical.

/** Task priority, matching the Prioritized Task Scheduling API. */
export type Priority = "user-blocking" | "user-visible" | "background";

/**
 * Continues a sliced task.
 * @param hintMs The time (ms) the scheduler knows is available for this slice, if any.
 *   The runner uses `min(budgetMs, hintMs)`. A value `<= 0` makes the runner skip
 *   this opportunity and schedule again.
 */
export type Resume = (hintMs?: number) => void;

/** Arranges for `resume` to be called later. */
export type Schedule = (resume: Resume) => void;

export interface CreateScheduleOptions {
  /**
   * Upper bound (ms) on how long a background slice may wait for an idle period
   * when `requestIdleCallback` is used. Defaults to `1000`.
   */
  idleTimeoutMs?: number;
}

/** Time (ms) left to the browser for rendering and other work in a frame. */
const FRAME_SAFETY_MS = 2;
/** Slice length (ms) used when an idle callback fires because of its timeout. */
const TIMED_OUT_SLICE_MS = 1;
const DEFAULT_IDLE_TIMEOUT_MS = 1000;

/**
 * Creates a scheduler for the given priority.
 *
 * 1. If the browser natively supports `scheduler.postTask()`, tasks are posted with
 *    the given priority and the browser arbitrates them with other work (e.g. React).
 *    Polyfilled implementations are deliberately ignored, because they cannot give
 *    `background` tasks a lower priority than ordinary tasks in every browser.
 * 2. Otherwise, `user-blocking` and `user-visible` use a macrotask (`MessageChannel`).
 * 3. Otherwise, `background` uses `requestIdleCallback` (passing the idle deadline as a
 *    hint), or falls back to one slice right after each frame, sized to the time
 *    estimated to remain before the next frame.
 */
export function createSchedule(
  priority: Priority = "background",
  options: CreateScheduleOptions = {},
): Schedule {
  const native = getNativeScheduler();
  if (native) {
    return (resume) => {
      void native.postTask(() => resume(), { priority });
    };
  }
  if (priority !== "background") return macrotask;
  if (typeof requestIdleCallback === "function") {
    const timeout = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    return (resume) => {
      requestIdleCallback(
        (deadline) => resume(deadline.didTimeout ? TIMED_OUT_SLICE_MS : deadline.timeRemaining()),
        { timeout },
      );
    };
  }
  if (typeof requestAnimationFrame === "function") return afterFrame;
  return macrotask;
}

/** @internal Returns `scheduler` only when it is the browser's native implementation. */
export function getNativeScheduler(): Scheduler | undefined {
  const g = globalThis as { scheduler?: unknown; Scheduler?: unknown };
  const SchedulerClass = g.Scheduler;
  if (typeof SchedulerClass === "function" && g.scheduler instanceof SchedulerClass) {
    const s = g.scheduler as Scheduler;
    if (typeof s.postTask === "function") return s;
  }
  return undefined;
}

// ---- macrotask ----

let channel: MessageChannel | undefined;
const channelQueue: Array<() => void> = [];

/**
 * Runs `resume` in a new macrotask, without a hint.
 *
 * - `setImmediate` (Node.js, Bun) keeps the process alive only while work is pending.
 *   A `MessageChannel` would keep it alive forever, or, if unref'ed, let it exit with
 *   the task unfinished.
 * - `MessageChannel` (browsers) is not clamped like `setTimeout`.
 * - `setTimeout` is the last resort.
 */
const macrotask: Schedule = (resume) => {
  if (typeof setImmediate === "function") {
    setImmediate(() => resume());
    return;
  }
  if (typeof MessageChannel === "undefined") {
    setTimeout(() => resume(), 0);
    return;
  }
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => channelQueue.shift()?.();
  }
  channelQueue.push(() => resume());
  channel.port2.postMessage(null);
};

// ---- after frame ----

/** Estimated frame interval (ms). Corrected from observed frames (e.g. 120 Hz displays). */
let frameIntervalMs = 1000 / 60;
let lastFrameTime = 0;

/**
 * Runs `resume` once right after the next frame is rendered,
 * passing the time estimated to remain before the following frame.
 * Because the hint is computed when each slice starts, slices of several tasks
 * in the same frame share the frame's remaining time.
 */
const afterFrame: Schedule = (resume) => {
  requestAnimationFrame((frameTime) => {
    const delta = frameTime - lastFrameTime;
    if (delta > 4 && delta < 40) frameIntervalMs = Math.min(frameIntervalMs, delta);
    lastFrameTime = frameTime;
    macrotask(() => resume(frameTime + frameIntervalMs - performance.now() - FRAME_SAFETY_MS));
  });
};
