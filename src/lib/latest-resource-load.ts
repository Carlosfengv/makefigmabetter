/**
 * Assigns a monotonic token to each load for one derived resource. Async
 * completions may publish only while their token is still current, preventing
 * an older decode from replacing the result requested most recently.
 */
export class LatestResourceLoad {
  private readonly attempts = new Map<string, number>();

  begin(resourceId: string): number {
    const attempt = (this.attempts.get(resourceId) ?? 0) + 1;
    this.attempts.set(resourceId, attempt);
    return attempt;
  }

  isCurrent(resourceId: string, attempt: number): boolean {
    return this.attempts.get(resourceId) === attempt;
  }
}

/** Returns the first available resource while allowing a fast cache miss to
 * keep waiting for an already-started bounded delivery. */
export function firstAvailableResource<T>(
  cached: Promise<T | undefined>,
  delivered: Promise<T | undefined>,
): Promise<T | undefined> {
  return Promise.race([
    delivered,
    cached.then((value) => value ?? delivered),
  ]);
}
