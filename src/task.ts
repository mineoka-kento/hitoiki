const AWAIT: unique symbol = Symbol("hitoiki.await");

/**
 * An instruction that asks the runner to wait for a promise.
 * Created only by {@link wait}; it cannot be constructed by user code.
 */
export interface Await {
  readonly [AWAIT]: PromiseLike<unknown>;
}

/**
 * A value a task may yield:
 * - `undefined` (a bare `yield`) marks a point where the task may be paused.
 * - {@link Await} (produced by `yield* wait(...)`) waits for a promise.
 */
export type Instruction = undefined | Await;

/**
 * A task: a generator run by {@link run}.
 *
 * - `yield` marks a point where the task may be paused.
 * - `yield value` does the same and also reports `value` as the task's progress.
 * - `yield* wait(promise)` waits for a promise.
 *
 * @typeParam T The task's result.
 * @typeParam P The progress values the task yields. `undefined` means "no new progress",
 *   and promises cannot be progress values (use `yield* wait(...)` to wait for them).
 */
export type Task<T = unknown, P = never> = Generator<P | Instruction, T, unknown>;

/**
 * Waits for a promise inside a task and returns its resolved value.
 * Always use it with `yield*`:
 *
 * ```ts
 * const user = yield* wait(fetchUser()); // user: User
 * ```
 *
 * If the promise rejects, the reason is thrown at this point,
 * so it can be caught with an ordinary `try`/`catch` inside the task.
 */
export function* wait<T>(value: T | PromiseLike<T>): Generator<Await, Awaited<T>, unknown> {
  const instruction: Await = { [AWAIT]: Promise.resolve(value) };
  // The runner resumes the task with the resolved value of `instruction`.
  // This cast is the only place where the type of a resumed value is asserted.
  return (yield instruction) as Awaited<T>;
}

/** @internal */
export function isAwait(value: unknown): value is Await {
  return typeof value === "object" && value !== null && AWAIT in value;
}

/** @internal */
export function promiseOf(instruction: Await): PromiseLike<unknown> {
  return instruction[AWAIT];
}

/** @internal */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** @internal */
export function rawPromiseError(): TypeError {
  return new TypeError(
    "hitoiki: a task yielded a promise directly. Use `yield* wait(promise)` to wait for it.",
  );
}
