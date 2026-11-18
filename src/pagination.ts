/** The server returned a cursor already used in this traversal. */
export class PaginationCycle extends Error {
  constructor(readonly cursor: string) {
    super(`pagination cursor repeated: ${JSON.stringify(cursor)}`);
    this.name = "PaginationCycle";
  }
}

/** Fetch complete pages only when the iterator advances. Empty pages can still
 * have a continuation cursor. The callback owns filters, cancellation and timeout.
 * Server cursors do not guarantee a stable snapshot while records change. */
export async function* pages<P extends { readonly next?: string | null }>(
  fetch: (cursor: string | undefined) => Promise<P>,
  cursor?: string,
): AsyncGenerator<P> {
  const seen = new Set<string>();
  for (;;) {
    if (cursor) {
      if (seen.has(cursor)) throw new PaginationCycle(cursor);
      seen.add(cursor);
    }
    const page = await fetch(cursor);
    yield page;
    cursor = page.next || undefined;
    if (!cursor) return;
  }
}
