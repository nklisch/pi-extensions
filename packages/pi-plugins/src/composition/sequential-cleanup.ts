export async function disposeSequentially(disposers: Iterable<() => void | Promise<void>>, message: string): Promise<void> {
  const errors: unknown[] = [];
  for (const dispose of disposers) {
    try { await dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, message);
}
