/**
 * Deno-std assert, expressed on node:assert so the file runs under BOTH bun and
 * deno.
 *
 * WHY: fiat_client_test.ts imported `https://deno.land/std@0.224.0/assert/mod.ts`,
 * which bun cannot resolve. The suite therefore failed to even load under the
 * default runner — 39 assertions that had never executed. A test that cannot run
 * is worse than no test: it looks like coverage.
 */
import nodeAssert from "node:assert";

export function assert(cond: unknown, msg?: string): void {
  nodeAssert.ok(cond, msg ?? "assertion failed");
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  nodeAssert.deepStrictEqual(actual, expected, msg);
}

function checkError(e: unknown, ErrorClass?: unknown, msgIncludes?: unknown): void {
  if (typeof ErrorClass === "function" && !(e instanceof (ErrorClass as never))) {
    throw new Error(`wrong error type: got ${(e as Error)?.name}, expected ${(ErrorClass as { name: string }).name}`);
  }
  if (typeof ErrorClass === "string") msgIncludes = ErrorClass;
  if (typeof msgIncludes === "string" && !String((e as Error)?.message).includes(msgIncludes)) {
    throw new Error(`error message ${JSON.stringify((e as Error)?.message)} does not include ${JSON.stringify(msgIncludes)}`);
  }
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  ErrorClass?: unknown,
  msgIncludes?: unknown,
): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    checkError(e, ErrorClass, msgIncludes);
    return e;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

export function assertThrows(fn: () => unknown, ErrorClass?: unknown, msgIncludes?: unknown): unknown {
  try {
    fn();
  } catch (e) {
    checkError(e, ErrorClass, msgIncludes);
    return e;
  }
  throw new Error("expected the function to throw, but it returned");
}
