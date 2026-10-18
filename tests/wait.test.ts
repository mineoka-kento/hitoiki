import { describe, expectTypeOf, test } from "vite-plus/test";
import { wait, type Task } from "../src/index.ts";

interface User {
  id: number;
  name: string;
}

describe("wait", () => {
  test("infers the resolved type of each promise separately", () => {
    function* task() {
      const user = yield* wait(Promise.resolve<User>({ id: 1, name: "a" }));
      const count = yield* wait(Promise.resolve(42));
      const plain = yield* wait("not a promise");
      const nested = yield* wait(Promise.resolve(Promise.resolve(true)));
      expectTypeOf(user).toEqualTypeOf<User>();
      expectTypeOf(count).toEqualTypeOf<number>();
      expectTypeOf(plain).toEqualTypeOf<string>();
      expectTypeOf(nested).toEqualTypeOf<boolean>();
      return { user, count };
    }
    expectTypeOf<ReturnType<typeof task>>().toExtend<Task<{ user: User; count: number }>>();
  });

  test("tasks that use wait are assignable to Task", () => {
    function* task(): Task<number> {
      yield;
      return yield* wait(Promise.resolve(1));
    }
    expectTypeOf(task()).toEqualTypeOf<Task<number>>();
  });

  test("requires yield* (a bare yield of wait() is a type error)", () => {
    function* task(): Task<void> {
      // @ts-expect-error `wait()` must be delegated to with `yield*`.
      yield wait(Promise.resolve(1));
    }
    expectTypeOf(task).toBeFunction();
  });

  test("a bare yield of a promise is a type error", () => {
    function* task(): Task<void> {
      // @ts-expect-error Promises must be waited for with `yield* wait(...)`.
      yield Promise.resolve(1);
    }
    expectTypeOf(task).toBeFunction();
  });
});
