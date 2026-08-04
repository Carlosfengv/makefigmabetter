import { describe, expect, it } from "vitest";
import { maintainWriterLease, type WriterLeaseMode } from "./writer-lease";

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("writer lease", () => {
  it("retries a read-only follower and promotes it after the owner releases", async () => {
    const modes: WriterLeaseMode[] = [];
    const attempts: Array<unknown | null> = [null, { granted: true }];
    const waits: Array<() => void> = [];
    const lease = maintainWriterLease({
      name: "document",
      request: async (_name, callback) => callback(attempts.shift() ?? null),
      onMode: (mode) => modes.push(mode),
      wait: () => new Promise<void>((resolve) => waits.push(resolve)),
    });

    await flush();
    await flush();
    expect(modes).toEqual(["acquiring", "read-only", "acquiring"]);
    waits.shift()?.();
    await flush();
    await flush();
    expect(modes.at(-1)).toBe("owner");

    lease.stop();
    await lease.finished;
  });

  it("stops cleanly while waiting as a follower", async () => {
    const waits: Array<() => void> = [];
    const lease = maintainWriterLease({
      name: "document",
      request: async (_name, callback) => callback(null),
      onMode: () => undefined,
      wait: () => new Promise<void>((resolve) => waits.push(resolve)),
    });

    await flush();
    lease.stop();
    waits.shift()?.();
    await lease.finished;
  });
});
