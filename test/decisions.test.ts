// Replays sdk/scenarios/decisions.json, the truth table of the generated write and retry decisions.

import { loadShared } from "./shared.js";
import { describe, expect, it } from "vitest";
import { readRetryable, retryRead, writeOutcomeUnknown } from "../src/generated/behavior.js";

interface Table {
  write_outcome_unknown: {
    case: string;
    status: number | null;
    code_status: number | null;
    unknown: boolean;
  }[];
  read_retryable: {
    case: string;
    code: number;
    status: number | null;
    code_retryable: boolean;
    retryable: boolean;
  }[];
  retry_read: { retryable: boolean; attempt: number; retry: boolean }[];
}

const table = loadShared("scenarios/decisions.json") as Table;
const opt = (v: number | null): number | undefined => v ?? undefined;

describe("shared decisions", () => {
  it.each(table.write_outcome_unknown)("write_outcome_unknown $case", (r) => {
    expect(writeOutcomeUnknown(opt(r.status), opt(r.code_status))).toBe(r.unknown);
  });
  it.each(table.read_retryable)("read_retryable $case", (r) => {
    expect(readRetryable(r.code, opt(r.status), r.code_retryable)).toBe(r.retryable);
  });
  it.each(table.retry_read)("retry_read retryable=$retryable attempt=$attempt", (r) => {
    expect(retryRead(r.retryable, r.attempt)).toBe(r.retry);
  });
});
