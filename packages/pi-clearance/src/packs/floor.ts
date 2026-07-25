import type { PolicyPack } from "../policy/core.ts";
import { compilePack } from "../policy/core.ts";

const SYSTEM_ROOT_TARGETS = [
  "/",
  "/*",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/proc",
  "/root",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
] as const;

const PRIVILEGE_ESCALATION_PROGRAMS = [
  "sudo",
  "su",
  "runuser",
  "pkexec",
  "doas",
  "setcap",
  "gksu",
  "gsu",
] as const;

const SHUTDOWN_PROGRAM_MATCHERS = [
  { program: "shutdown" },
  { program: "reboot" },
  { program: "halt" },
  { program: "poweroff" },
  { all: [{ program: "init" }, { arg0In: ["0", "6"] }] },
  { all: [{ program: "telinit" }, { arg0In: ["0", "6"] }] },
  {
    all: [{ program: "systemctl" }, { arg0In: ["poweroff", "reboot", "halt"] }],
  },
] as const;

const MKFS_PROGRAMS = [
  "mkfs",
  "mke2fs",
  "mkdosfs",
  "mkfs.ext2",
  "mkfs.ext3",
  "mkfs.ext4",
  "mkfs.xfs",
  "mkfs.btrfs",
  "mkfs.vfat",
  "mkfs.fat",
  "mkfs.ntfs",
  "mkfs.exfat",
  "mkfs.f2fs",
  "mkfs.minix",
  "mkfs.cramfs",
] as const;

const floorRaw = {
  version: 1,
  id: "floor.deny",
  rules: [
    {
      id: "floor:deny-rm-system-root",
      effect: "deny",
      match: {
        stageSome: {
          all: [{ program: "rm" }, { arg0In: [...SYSTEM_ROOT_TARGETS] }],
        },
      },
      reason: "recursive deletion of a system root is catastrophic",
      provenance: { source: "shipped" },
    },
    {
      id: "floor:deny-privilege-escalation",
      effect: "deny",
      match: {
        stageSome: {
          any: PRIVILEGE_ESCALATION_PROGRAMS.map((program) => ({ program })),
        },
      },
      reason:
        "privilege escalation is a trust-boundary event, never auto-allowed",
      provenance: { source: "shipped" },
    },
    {
      id: "floor:deny-system-shutdown",
      effect: "deny",
      match: { stageSome: { any: SHUTDOWN_PROGRAM_MATCHERS } },
      reason: "system shutdown/reboot is catastrophic to the session and host",
      provenance: { source: "shipped" },
    },
    {
      id: "floor:deny-dd-device-write",
      effect: "deny",
      match: {
        stageSome: {
          all: [
            { program: "dd" },
            { anyArgMatches: "^of=/dev/.*" },
            {
              not: {
                anyArgMatches:
                  "^of=/dev/(null|zero|full|random|urandom|stdin|stdout|stderr|fd/.*)$",
              },
            },
          ],
        },
      },
      reason: "dd writing a device is catastrophic to the host",
      provenance: { source: "shipped" },
    },
    {
      id: "floor:deny-mkfs-device",
      effect: "deny",
      match: {
        stageSome: {
          all: [
            { any: MKFS_PROGRAMS.map((program) => ({ program })) },
            { anyArgMatches: "^/dev/.*" },
          ],
        },
      },
      reason: "creating a filesystem on a device is catastrophic to the host",
      provenance: { source: "shipped" },
    },
  ],
} as const;

const compiledFloor = compilePack(floorRaw);
if (compiledFloor.pack === null) {
  throw new Error(
    `sealed floor failed to compile: ${JSON.stringify(compiledFloor.errors)}`,
  );
}

/** Immutable, deny-only sealed floor used by every native composition. */
export const sealedFloor: PolicyPack = compiledFloor.pack;
