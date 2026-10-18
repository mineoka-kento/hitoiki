import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vite-plus/test";
import * as hitoiki from "../src/index.ts";

test("public API", () => {
  expect(Object.keys(hitoiki).sort()).toEqual([
    "TaskWaitingError",
    "createSchedule",
    "run",
    "wait",
  ]);
});

test("runs with the default scheduler in Node.js", async () => {
  function* task() {
    const a = yield* hitoiki.wait(Promise.resolve(1));
    yield;
    return a + 1;
  }
  await expect(hitoiki.run(task())).resolves.toBe(2);
  await expect(hitoiki.run(task(), { priority: "user-visible" })).resolves.toBe(2);
});

/**
 * Runs a script in a separate Node.js process, where the test runner does not keep the
 * event loop alive. The script can import the library as `HITOIKI`.
 */
async function runNodeScript(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "hitoiki-"));
  try {
    const file = join(dir, "script.mjs");
    const entry = pathToFileURL(resolve(import.meta.dirname, "../src/index.ts")).href;
    await writeFile(file, source.replaceAll("HITOIKI", JSON.stringify(entry)));
    const features = process.features as { typescript?: unknown };
    const flags = features.typescript ? [] : ["--experimental-strip-types"];
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--no-warnings", ...flags, file],
      { timeout: 10_000 },
    );
    return stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("in a plain Node.js process", () => {
  test("keeps the process alive until the task completes", async () => {
    const stdout = await runNodeScript(`
      import { run, wait } from HITOIKI;
      function* task() {
        let total = 0;
        for (let i = 1; i <= 100_000; i++) {
          total += i;
          yield;
        }
        total += yield* wait(new Promise((resolve) => setTimeout(() => resolve(1), 20)));
        return total;
      }
      // No top-level await: only pending slices keep the process alive.
      run(task()).then((value) => console.log("background", value));
      run(task(), { priority: "user-visible" }).then((value) => console.log("visible", value));
    `);
    expect(stdout.split("\n").sort()).toEqual(["background 5000050001", "visible 5000050001"]);
  });

  test("lets the process exit once there is nothing left to do", async () => {
    const started = performance.now();
    const stdout = await runNodeScript(`
      import { run } from HITOIKI;
      function* task() { yield; return "done"; }
      console.log(await run(task()));
    `);
    expect(stdout).toBe("done");
    expect(performance.now() - started).toBeLessThan(9_000); // well before the timeout
  });
});
