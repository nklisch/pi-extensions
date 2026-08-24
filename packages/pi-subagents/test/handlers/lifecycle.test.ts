import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleManager, LifecycleRuntime } from "#src/handlers/lifecycle";
import { SessionLifecycleHandler } from "#src/handlers/lifecycle";

describe("SessionLifecycleHandler", () => {
  let runtime: LifecycleRuntime;
  let manager: LifecycleManager;
  let mockSetSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["setSessionContext"]>>;
  let mockClearSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["clearSessionContext"]>>;
  let mockClearCompleted: ReturnType<typeof vi.fn<LifecycleManager["clearCompleted"]>>;
  let mockAbortAll: ReturnType<typeof vi.fn<LifecycleManager["abortAll"]>>;
  let mockDispose: ReturnType<typeof vi.fn<LifecycleManager["dispose"]>>;
  let mockDisposeNotifications: ReturnType<typeof vi.fn<() => void>>;
  let mockUnpublishService: ReturnType<typeof vi.fn<() => void>>;
  let handler: SessionLifecycleHandler;

  beforeEach(() => {
    mockSetSessionContext = vi.fn();
    mockClearSessionContext = vi.fn();
    mockClearCompleted = vi.fn(async () => {});
    mockAbortAll = vi.fn();
    mockDispose = vi.fn(async () => {});
    mockDisposeNotifications = vi.fn();
    mockUnpublishService = vi.fn();

    runtime = {
      setSessionContext: mockSetSessionContext,
      clearSessionContext: mockClearSessionContext,
    };
    manager = {
      clearCompleted: mockClearCompleted,
      abortAll: mockAbortAll,
      dispose: mockDispose,
    };

    handler = new SessionLifecycleHandler(
      runtime,
      manager,
      mockDisposeNotifications,
      mockUnpublishService,
    );
  });

  describe("handleSessionStart", () => {
    it("sets session context and clears completed agents", async () => {
      const ctx = { cwd: "/some/path" };

      await handler.handleSessionStart({}, ctx);

      expect(runtime.setSessionContext).toHaveBeenCalledWith(ctx);
      expect(manager.clearCompleted).toHaveBeenCalled();
    });

    it("sets context before clearing completed", async () => {
      const callOrder: string[] = [];
      mockSetSessionContext.mockImplementation(() => {
        callOrder.push("setSessionContext");
      });
      mockClearCompleted.mockImplementation(async () => {
        callOrder.push("clearCompleted");
      });

      await handler.handleSessionStart({}, {});

      expect(callOrder).toEqual(["setSessionContext", "clearCompleted"]);
    });
  });

  describe("handleSessionBeforeSwitch", () => {
    it("clears completed agents", async () => {
      await handler.handleSessionBeforeSwitch();

      expect(manager.clearCompleted).toHaveBeenCalled();
    });
  });

  describe("handleSessionShutdown", () => {
    it("calls all cleanup steps", async () => {
      await handler.handleSessionShutdown();

      expect(mockUnpublishService).toHaveBeenCalled();
      expect(mockClearSessionContext).toHaveBeenCalled();
      expect(mockAbortAll).toHaveBeenCalled();
      expect(mockDisposeNotifications).toHaveBeenCalled();
      expect(mockDispose).toHaveBeenCalled();
    });

    it("calls cleanup in correct order", async () => {
      const callOrder: string[] = [];
      mockUnpublishService.mockImplementation(() => { callOrder.push("unpublishService"); });
      mockClearSessionContext.mockImplementation(() => {
        callOrder.push("clearSessionContext");
      });
      mockAbortAll.mockImplementation(() => {
        callOrder.push("abortAll");
      });
      mockDisposeNotifications.mockImplementation(() => { callOrder.push("disposeNotifications"); });
      mockDispose.mockImplementation(async () => {
        callOrder.push("dispose");
      });

      await handler.handleSessionShutdown();

      expect(callOrder).toEqual([
        "unpublishService",
        "clearSessionContext",
        "disposeNotifications",
        "abortAll",
        "dispose",
      ]);
    });

    it("suppresses queued-agent follow-ups before aborting during shutdown", async () => {
      let notificationsActive = true;
      const sendFollowUp = vi.fn();
      mockDisposeNotifications.mockImplementation(() => {
        notificationsActive = false;
      });
      mockAbortAll.mockImplementation(() => {
        if (notificationsActive) sendFollowUp();
      });

      await handler.handleSessionShutdown();

      expect(sendFollowUp).not.toHaveBeenCalled();
      expect(mockAbortAll).toHaveBeenCalledOnce();
    });
  });
});
