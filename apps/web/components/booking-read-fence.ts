/** Only the newest read may update the screen, including after a mutation starts. */
export function createBookingReadFence() {
  let generation = 0;
  return {
    invalidate() {
      generation += 1;
    },
    async run<T>(
      read: () => Promise<T>,
      apply: (value: T) => void,
      fail: (error: unknown) => void,
    ): Promise<T | null> {
      const started = ++generation;
      try {
        const value = await read();
        if (started !== generation) return null;
        apply(value);
        return value;
      } catch (error) {
        if (started === generation) fail(error);
        return null;
      }
    },
  };
}
