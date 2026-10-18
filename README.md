# hitoiki

Run heavy work on the main thread without blocking the UI.

Write the work as a generator function and run it **with breathers**: in time slices
that give the browser a chance to handle input and render between them. When you need
the result right away, finish it **in one go**, synchronously, at any moment.

> _Hitoiki_ (一息) is Japanese for "a breath". _Hitoiki tsuku_ means "to take a breather",
> and _hitoiki ni_ means "in one go" — the two ways this library runs your work.

## Why

Web Workers are the usual answer to long tasks, but sometimes they do not fit:

- the data is large and copying it to a worker costs more than the work itself,
- the work draws to a `<canvas>` and `OffscreenCanvas` is not an option,
- the result is wanted synchronously when possible.

hitoiki keeps the work on the main thread and slices it cooperatively.

## Usage

```ts
import { run, wait } from "hitoiki";

function* buildChartData(rows: Row[]) {
  const points: Point[] = [];
  for (let i = 0; i < rows.length; i++) {
    points.push(toPoint(rows[i]));
    if ((i & 1023) === 0) yield; // a point where the task may pause
  }
  return points;
}

const points = await run(buildChartData(rows));
```

A `yield` only marks a point where pausing is allowed. The runner checks the time there
and actually gives control back only when the slice's budget (5 ms by default) is used up.

### Finishing synchronously

`run()` returns a promise of the result that can also be driven synchronously, at any time:

```ts
const running = run(buildChartData(rows));

// Run for up to 5 ms right now; get the result if it completes in that time.
const result = running.tryFinish(5);
if (result.done) draw(result.value);

// Run right now until it completes, however long it takes.
draw(running.finish());
```

- `tryFinish(budgetMs?)` returns `{ done: true, value }` when the task completes within
  the budget (defaults to the `budgetMs` option). Otherwise it returns `{ done: false }`
  and the task keeps running in time slices.
- `finish()` has no time limit. If the task is waiting for a promise, it cannot finish
  synchronously: a `TaskWaitingError` is thrown and the task keeps running.
- Both throw the task's error if it fails.

### Reporting progress

`yield value` marks a pause point and also reports `value` as the task's progress.
The latest value can be read from `running.progress` at any time. Its type is inferred
from what the task yields, so it can be anything: a number, an object, a message.

```ts
function* buildChartData(rows: Row[]) {
  const points: Point[] = [];
  for (let i = 0; i < rows.length; i++) {
    points.push(toPoint(rows[i]));
    if ((i & 1023) === 0) yield { done: i, total: rows.length };
  }
  return points;
}

const running = run(buildChartData(rows));
running.progress; // { done: number; total: number } | undefined
```

- `progress` is `undefined` until the task yields its first value.
- A bare `yield` does not change it, and it keeps its last value after the task ends.
- To clear it, yield a value of your own such as `null` (`undefined` means "no new progress").
- To fix the type, annotate the generator: `function* f(): Task<Point[], number> { ... }`.

### Observing the state

`running.state` is a snapshot of the task, read without side effects:

```ts
type TaskState<T, P> =
  | { status: "running"; progress: P | undefined }
  | { status: "fulfilled"; value: T; progress: P | undefined }
  | { status: "rejected"; reason: unknown; progress: P | undefined }; // also when aborted
```

`running.subscribe(listener)` calls `listener` when the state changes and returns a function
to unsubscribe. Notifications are batched to at most one per slice, however many progress
values are yielded in it, and the same snapshot object is kept until the next change.
This fits React's `useSyncExternalStore`:

```tsx
function useTaskState<T, P>(running: Running<T, P>) {
  return useSyncExternalStore(running.subscribe, () => running.state);
}

function ChartLoader({ running }: { running: Running<Point[], { done: number; total: number }> }) {
  const state = useTaskState(running);
  switch (state.status) {
    case "running":
      return <Progress value={state.progress?.done} max={state.progress?.total} />;
    case "fulfilled":
      return <Chart points={state.value} />;
    case "rejected":
      return <ErrorMessage error={state.reason} />;
  }
}
```

### Waiting for promises

Use `yield* wait(promise)`. The resolved type is inferred for each call.

```ts
function* load() {
  const user = yield* wait(fetchUser()); // User
  const stats = yield* wait(fetchStats(user.id)); // Stats
  return summarize(user, stats);
}

await run(load());
run(load()).finish(); // throws TaskWaitingError: this task waits for promises
```

A rejected promise is thrown at the `yield*`, so it can be caught with `try`/`catch`.

### Options

```ts
await run(task, {
  priority: "user-visible", // default: "background"
  budgetMs: 5, // maximum length of one slice
  signal: controller.signal, // abort: `finally` blocks run, the promise rejects
});
```

`priority` decides how the task competes with other work on the page:

- `"background"` (default) lets other work, such as React rendering, go first.
- `"user-visible"` / `"user-blocking"` are for work the user is waiting for.

## How slices are scheduled

1. If the browser natively supports `scheduler.postTask()`, each slice is posted with the
   given priority. (Polyfills are ignored, because they cannot lower the priority of
   background work in every browser.)
2. Otherwise, `user-visible` and `user-blocking` slices run in a new macrotask.
3. Otherwise, `background` slices run in `requestIdleCallback` (with a timeout), capped by
   the idle deadline, or right after a frame, capped by the time estimated to remain before
   the next frame.

You can pass your own scheduler with the `schedule` option, or build one with
`createSchedule(priority)`.

## Development

```bash
vp install   # install dependencies
vp check     # format, lint and type check
vp test      # run the tests
vp pack      # build the library
```

## License

MIT
