import type { GapRange } from "./runtime/hooks.js";
import { pages } from "./pagination.js";

export interface BackfillPage<P> {
  readonly page: P;
  readonly gap: GapRange;
  readonly historyExhausted: boolean;
  readonly continuity: "unproven";
}
/** The callback chooses the REST endpoint and time window. Sequence bounds are
 * not REST cursors. Exhausted history never proves that every missed event is visible. */
export async function* backfillPages<P extends { readonly next?: string | null }>(
  fetch: (cursor: string | undefined) => Promise<P>,
  gap: GapRange,
): AsyncGenerator<BackfillPage<P>> {
  const range = Object.freeze({ ...gap });
  for await (const page of pages(fetch))
    yield Object.freeze({
      page,
      gap: range,
      historyExhausted: !page.next,
      continuity: "unproven" as const,
    });
}
