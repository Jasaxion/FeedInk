export async function cleanupFixture(
  steps: ReadonlyArray<readonly [string, () => unknown | Promise<unknown>]>,
  primary?: { error: unknown },
): Promise<void> {
  const errors: Array<{ operation: string; error: unknown }> = primary ? [{ operation: "test body", error: primary.error }] : [];
  for (const [operation, close] of steps) {
    try { await close(); } catch (error) { errors.push({ operation, error }); }
  }
  if (errors.length === 1) throw errors[0].error;
  if (errors.length) throw new AggregateError(errors.map(({ operation, error }) => new Error(operation, { cause: error })), "Fixture failures and cleanup errors");
}
