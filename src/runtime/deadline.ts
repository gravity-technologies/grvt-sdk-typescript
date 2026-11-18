import { ConfigError } from "./errors.js";

/** One absolute budget for preparation, retries and the final exchange call. */
export class CallDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly expires: number;
  private timer: ReturnType<typeof setTimeout>;

  constructor(timeoutMs: number, signals: AbortSignal[] = []) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new ConfigError("timeoutMs must be finite and positive");
    this.expires = performance.now() + timeoutMs;
    this.signal = AbortSignal.any([this.controller.signal, ...signals]);
    this.timer = setTimeout(() => this.tick(), Math.min(timeoutMs, 2 ** 31 - 1));
  }

  private tick(): void {
    this.expire();
    if (!this.controller.signal.aborted)
      this.timer = setTimeout(
        () => this.tick(),
        Math.min(this.expires - performance.now(), 2 ** 31 - 1),
      );
  }

  private expire(): void {
    if (performance.now() >= this.expires)
      this.controller.abort(new DOMException("call deadline exceeded", "TimeoutError"));
  }

  check(): void {
    this.expire();
    this.signal.throwIfAborted();
  }

  /** Detach a cancelled caller from shared preparation without cancelling the shared work. */
  wait<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.signal.reason);
      // Attach observers before checking cancellation, including for already aborted callers.
      work.then(resolve, reject).finally(() => this.signal.removeEventListener("abort", abort));
      try {
        this.check();
      } catch (error) {
        reject(error);
        return;
      }
      this.signal.addEventListener("abort", abort, { once: true });
    });
  }

  close(): void {
    clearTimeout(this.timer);
  }
}
