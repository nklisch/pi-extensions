import { describe, it } from "vitest";

import { bashSystemReadPack } from "../../src/packs/bash.system.read.ts";
import {
  expectAllowFromPack,
  expectCleanLoad,
  expectDecisionEffect,
} from "./helpers.ts";

describe("bash.system.read pack", () => {
  it("loads cleanly against the sealed floor", () => {
    expectCleanLoad(bashSystemReadPack);
  });

  it.each([
    "journalctl -u svc -n 50",
    "docker ps",
    "podman inspect image",
    "docker logs --tail 50 container",
    "docker stats --no-stream",
  ])("allows read-only system inspection: %s", async (command) => {
    await expectAllowFromPack(command, bashSystemReadPack, "bash.system.read");
  });

  it.each([
    "journalctl --vacuum-size=1G",
    "journalctl --rotate",
    "systemctl status svc",
    "systemctl --user status svc",
    "systemctl list-timers",
    "systemctl --type=service",
    "systemctl restart svc",
    "systemctl -H host status svc",
    "docker logs -f container",
    "docker stats",
    "docker run image",
  ])("keeps mutating, remote, or watching system form gated: %s", async (command) => {
    await expectDecisionEffect(command, bashSystemReadPack, "review");
  });

  it("keeps systemctl poweroff denied by the sealed floor", async () => {
    await expectDecisionEffect(
      "systemctl poweroff",
      bashSystemReadPack,
      "deny",
    );
  });
});
