import { createSchedule, type Priority, type Resume, type Schedule } from "./schedule.ts";
import { isAwait, isThenable, promiseOf, rawPromiseError, type Instruction } from "./task.ts";

export interface RunOptions {
  /**
   * Maximum length (ms) of one slice. Defaults to `5`.
   * The time is checked only at `yield`, so the actual slice length is this value
   * plus the longest stretch of work between two yields.
   */
  budgetMs?: number;
  /**
   * Priority used by the default scheduler. Defaults to `"background"`,
   * which lets other work on the page (e.g. React rendering) go first.
   * Use `"user-visible"` when the user is waiting for the result.
   */
  priority?: Priority;
  /** Aborts the task. Its `finally` blocks run and the promise rejects with `signal.reason`. */
  signal?: AbortSignal;
  /** Custom scheduler. Overrides `priority`. */
  schedule?: Schedule;
}

/** The result of {@link Running.tryFinish}. */
export type TryFinishResult<T> =
  | { readonly done: true; readonly value: T }
  | { readonly done: false };

/**
 * A snapshot of a task's state, read from {@link Running.state}.
 *
 * - `"running"`: not completed yet (including before the first slice and while waiting
 *   for a promise).
 * - `"fulfilled"`: completed with `value`.
 * - `"rejected"`: failed with `reason`. An aborted task is rejected with `signal.reason`.
 *
 * `progress` is the latest progress value the task yielded, or `undefined` if none yet.
 * It keeps its last value after the task ends.
 */
export type TaskState<T, P = never> =
  | { readonly status: "running"; readonly progress: P | undefined }
  | { readonly status: "fulfilled"; readonly value: T; readonly progress: P | undefined }
  | { readonly status: "rejected"; readonly reason: unknown; readonly progress: P | undefined };

/** Called by {@link Running.subscribe} with the new state. */
export type StateListener<T, P = never> = (state: TaskState<T, P>) => void;

/**
 * A task started by {@link run}.
 * It is a promise of the task's result, and can also be observed and driven synchronously.
 * Its methods do not depend on `this`, so they can be destructured.
 *
 * @typeParam T The task's result.
 * @typeParam P The progress values the task yields.
 */
export interface Running<T, P = never> extends Promise<T> {
  /**
   * The current state of the task. Reading it has no side effects.
   *
   * The same object is returned until the state changes, so it can be used as the
   * snapshot of React's `useSyncExternalStore` together with {@link Running.subscribe}.
   */
  readonly state: TaskState<T, P>;
  /**
   * The latest progress value the task yielded (`yield value`),
   * or `undefined` if it has not yielded one yet. Same as `state.progress`.
   * A bare `yield` does not change it, and it keeps its last value after the task ends.
   */
  readonly progress: P | undefined;
  /**
   * Calls `listener` when {@link Running.state} changes. Returns a function that
   * stops the notifications.
   *
   * To keep the cost low, notifications are batched: at most once per slice (and once
   * per {@link Running.tryFinish} / {@link Running.finish} call), however many progress
   * values the task yields in it. Completion, failure and abort are always notified.
   * No notification follows once the task has ended.
   */
  readonly subscribe: (listener: StateListener<T, P>) => () => void;
  /**
   * Runs the task synchronously, right now, for up to `budgetMs` (defaults to the
   * `budgetMs` option of {@link run}).
   *
   * - If the task completes within that time, returns `{ done: true, value }`.
   * - Otherwise returns `{ done: false }`, and the task keeps running in time slices.
   *   This also happens without running anything if the task is waiting for a promise.
   *
   * If the task has failed (or fails now), its error is thrown.
   */
  readonly tryFinish: (budgetMs?: number) => TryFinishResult<T>;
  /**
   * Runs the task synchronously, right now, until it completes, and returns its result.
   * There is no time limit.
   *
   * If the task is (or starts) waiting for a promise, it cannot complete synchronously:
   * a {@link TaskWaitingError} is thrown and the task keeps running in time slices.
   * If the task has failed (or fails now), its error is thrown.
   */
  readonly finish: () => T;
}

/** Thrown by {@link Running.finish} when the task is waiting for a promise. */
export class TaskWaitingError extends Error {
  override name = "TaskWaitingError";
  constructor() {
    super(
      "hitoiki: the task cannot finish synchronously because it is waiting for a promise (`yield* wait(...)`). It keeps running; await it instead.",
    );
  }
}

const DEFAULT_BUDGET_MS = 5;

/** Internal phase. `"scheduled"`, `"running"` and `"waiting"` are all the public `"running"`. */
type Phase = "scheduled" | "running" | "waiting" | "fulfilled" | "rejected";

const noop = () => {};

/** Reports an error thrown by a listener without interrupting the task. */
const reportListenerError = (error: unknown) => {
  if (typeof reportError === "function") {
    reportError(error);
  } else {
    setTimeout(() => {
      throw error;
    }, 0);
  }
};

/** The progress values among the values a task yields. */
type ProgressOf<Y> = Exclude<Y, Instruction>;

/** Makes yielding a promise directly (instead of `yield* wait(promise)`) a type error. */
type NoPromiseYielded<Y> = [Extract<Y, PromiseLike<unknown>>] extends [never]
  ? unknown
  : { "hitoiki: use `yield* wait(promise)` instead of yielding a promise": never };

/**
 * Runs a task in time slices, giving control back to the browser between slices.
 *
 * The returned value is a promise of the task's result. Its state and progress can be
 * read and subscribed to, and it can be finished synchronously when needed, with
 * {@link Running.tryFinish} and {@link Running.finish}.
 */
export function run<T, Y>(
  task: Generator<Y, T, unknown> & NoPromiseYielded<Y>,
  options: RunOptions = {},
): Running<T, ProgressOf<Y>> {
  type P = ProgressOf<Y>;
  const { budgetMs = DEFAULT_BUDGET_MS, priority = "background", signal } = options;
  const schedule = options.schedule ?? createSchedule(priority);

  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  let phase: Phase = "scheduled";
  let value = undefined as T;
  let reason: unknown;
  let progress: P | undefined;
  /** Whether a scheduled slice is pending. */
  let slicePending = false;
  const next = () => task.next();
  let resume: () => IteratorResult<Y, T> = next;

  const ended = () => phase === "fulfilled" || phase === "rejected";

  // ---- state and notifications ----

  /** Incremented whenever the public state changes. */
  let version = 0;
  let snapshot: TaskState<T, P> | undefined;
  let snapshotVersion = -1;
  let notifiedVersion = 0;
  const listeners = new Set<StateListener<T, P>>();

  /** Returns the current state, creating a new snapshot only after a change. */
  const getState = (): TaskState<T, P> => {
    if (!snapshot || snapshotVersion !== version) {
      snapshot =
        phase === "fulfilled"
          ? { status: "fulfilled", value, progress }
          : phase === "rejected"
            ? { status: "rejected", reason, progress }
            : { status: "running", progress };
      snapshotVersion = version;
    }
    return snapshot;
  };

  /** Notifies listeners if the state changed since the last notification. */
  const notify = () => {
    if (notifiedVersion === version) return;
    notifiedVersion = version;
    const state = getState();
    const targets = [...listeners];
    if (ended()) listeners.clear(); // no more notifications will follow
    for (const listener of targets) {
      try {
        listener(state);
      } catch (error) {
        reportListenerError(error);
      }
    }
  };

  const subscribe = (listener: StateListener<T, P>): (() => void) => {
    if (ended()) return noop;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  // ---- settling ----

  const fulfill = (result: T) => {
    phase = "fulfilled";
    value = result;
    version++;
    signal?.removeEventListener("abort", onAbort);
    resolve(result);
  };

  const fail = (error: unknown) => {
    phase = "rejected";
    reason = error;
    version++;
    signal?.removeEventListener("abort", onAbort);
    reject(error);
  };

  /** Closes the task (running its `finally` blocks) and rejects with the abort reason. */
  const cancel = () => {
    try {
      task.return(undefined as never);
    } catch (error) {
      fail(error);
      return;
    }
    fail(signal?.reason);
  };

  // While a slice is running, the abort is handled at the next `yield`.
  function onAbort() {
    if (phase === "scheduled" || phase === "waiting") {
      cancel();
      notify();
    }
  }

  // ---- slicing ----

  /**
   * Runs the task synchronously for up to `limitMs` (at least one step), then notifies
   * listeners of any change. Returns `true` if it stopped because the time ran out.
   */
  const slice = (limitMs: number): boolean => {
    const outOfTime = step(limitMs);
    notify();
    // A listener may have finished or aborted the task in the meantime.
    return outOfTime && phase === "scheduled";
  };

  const step = (limitMs: number): boolean => {
    phase = "running";
    const timed = limitMs !== Infinity;
    const end = timed ? performance.now() + limitMs : Infinity;
    try {
      for (;;) {
        const result = resume();
        resume = next;
        if (result.done) {
          fulfill(result.value);
          return false;
        }
        const yielded = result.value;
        if (isAwait(yielded)) {
          phase = "waiting";
          promiseOf(yielded).then(
            (resolved) => continueWith(() => task.next(resolved)),
            (rejected: unknown) => continueWith(() => task.throw(rejected)),
          );
          return false;
        }
        if (yielded !== undefined) {
          if (isThenable(yielded)) {
            const error = rawPromiseError();
            resume = () => task.throw(error);
            continue;
          }
          if (!Object.is(progress, yielded)) {
            progress = yielded as P;
            version++;
          }
        }
        if (signal?.aborted) {
          cancel();
          return false;
        }
        if (timed && performance.now() >= end) {
          phase = "scheduled";
          return true;
        }
      }
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const requestSlice = () => {
    if (slicePending) return;
    slicePending = true;
    schedule(onScheduled);
  };

  const onScheduled: Resume = (hintMs) => {
    slicePending = false;
    if (phase !== "scheduled") return;
    if (hintMs !== undefined && hintMs <= 0) {
      requestSlice();
      return;
    }
    if (slice(Math.min(budgetMs, hintMs ?? Infinity))) requestSlice();
  };

  /** Resumes the task after the promise it was waiting for has settled. */
  const continueWith = (fn: () => IteratorResult<Y, T>) => {
    if (phase !== "waiting") return;
    resume = fn;
    phase = "scheduled";
    requestSlice();
  };

  // ---- synchronous control ----

  const runNow = (limitMs: number) => {
    if (phase === "running") {
      throw new Error("hitoiki: tryFinish() and finish() cannot be called from inside the task.");
    }
    if (phase === "scheduled" && slice(limitMs)) requestSlice();
  };

  const throwReason = (): never => {
    // The caller receives the error synchronously; do not also report it as unhandled.
    promise.catch(noop);
    throw reason;
  };

  const tryFinish = (limitMs: number = budgetMs): TryFinishResult<T> => {
    runNow(limitMs);
    if (phase === "fulfilled") return { done: true, value };
    if (phase === "rejected") return throwReason();
    return { done: false };
  };

  const finish = (): T => {
    runNow(Infinity);
    if (phase === "fulfilled") return value;
    if (phase === "rejected") return throwReason();
    throw new TaskWaitingError();
  };

  // ---- start ----

  if (signal?.aborted) {
    cancel();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
    requestSlice();
  }
  // Nobody can have subscribed yet, so the initial state is not a change to notify.
  notifiedVersion = version;

  return Object.defineProperties(promise, {
    state: { get: getState, enumerable: true },
    progress: { get: () => progress, enumerable: true },
    subscribe: { value: subscribe, enumerable: true },
    tryFinish: { value: tryFinish, enumerable: true },
    finish: { value: finish, enumerable: true },
  }) as Running<T, P>;
}
