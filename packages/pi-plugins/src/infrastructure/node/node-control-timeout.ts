import type { NativeControlTimeoutPort } from "../../application/ports/native-control-execution.js";

export function createNodeControlTimeoutPort(): NativeControlTimeoutPort {
  return Object.freeze({
    arm(timeoutMs: number, parent: AbortSignal) {
      const controller = new AbortController();
      const abortParent = () => controller.abort(parent.reason);
      if (parent.aborted) abortParent();
      else parent.addEventListener("abort", abortParent, { once: true });
      const timer = setTimeout(() => controller.abort(new DOMException("native control timeout", "TimeoutError")), timeoutMs);
      timer.unref?.();
      let disposed = false;
      return Object.freeze({
        signal: controller.signal,
        dispose() {
          if (disposed) return;
          disposed = true;
          clearTimeout(timer);
          parent.removeEventListener("abort", abortParent);
        },
      });
    },
  });
}
