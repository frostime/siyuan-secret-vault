/**
 * Serializes complete persistent-state mutation lifecycles.
 *
 * The callback does not start until the previous callback has settled. Callers
 * keep validation, crypto staging, persistence, in-memory commit, and related
 * runtime-state updates inside that callback so no two vault writes can
 * observe or commit partially overlapping state.
 */
export class VaultMutationCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.closed) throw new Error("秘密库已经停止");
      return operation();
    });

    // A failed operation must not poison the queue. The caller still receives
    // the original result/rejection through `result`.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  close(): void {
    this.closed = true;
  }
}
