import { describe, expect, test } from "bun:test";
import { readListenHost } from "./listen.ts";

describe("readListenHost", () => {
  test("defaults to loopback when unset", () => {
    expect(readListenHost(() => undefined)).toBe("127.0.0.1");
  });

  test("uses an explicit CVM_CUSTOMER_HOST", () => {
    expect(
      readListenHost((name) =>
        name === "CVM_CUSTOMER_HOST" ? "fd36:3c0f:d6f:8029:ea50:958b:672e:bb0" : undefined
      ),
    ).toBe("fd36:3c0f:d6f:8029:ea50:958b:672e:bb0");
  });

  test("a blank override still binds loopback", () => {
    expect(readListenHost((name) => (name === "CVM_CUSTOMER_HOST" ? "   " : undefined)))
      .toBe("127.0.0.1");
  });
});
