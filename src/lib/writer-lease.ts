export type WriterLeaseMode = "acquiring" | "owner" | "read-only";

export interface WriterLease {
  stop(): void;
  finished: Promise<void>;
}

type LockRequester = (name: string, callback: (lock: unknown | null) => Promise<void>) => Promise<void>;

/**
 * Keeps attempting an if-available Web Lock. A follower therefore becomes owner
 * after the current owner closes, without ever allowing two local writers.
 */
export function maintainWriterLease({ name, request, onMode, retryMs = 750, wait = delay }: {
  name: string;
  request: LockRequester;
  onMode: (mode: WriterLeaseMode) => void;
  retryMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}): WriterLease {
  let stopped = false;
  let releaseOwner: (() => void) | undefined;

  const finished = (async () => {
    onMode("acquiring");
    while (!stopped) {
      let becameOwner = false;
      try {
        await request(name, async (lock) => {
          if (!lock) {
            if (!stopped) onMode("read-only");
            return;
          }
          becameOwner = true;
          if (!stopped) onMode("owner");
          await new Promise<void>((resolve) => { releaseOwner = resolve; });
          releaseOwner = undefined;
        });
      } catch {
        if (!stopped) onMode("read-only");
      }
      if (stopped) break;
      onMode("acquiring");
      await wait(becameOwner ? 0 : retryMs);
    }
  })();

  return {
    stop() { stopped = true; releaseOwner?.(); },
    finished,
  };
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
