import { bashCompoundReadPack } from "./bash.compound.read.ts";
import { bashDevVerifyPack } from "./bash.dev.verify.ts";
import { bashInspectCorePack } from "./bash.inspect.core.ts";
import { bashNetworkReadPack } from "./bash.network.read.ts";
import { bashPackagesCommonPack } from "./bash.packages.common.ts";
import { bashProjectConstructivePack } from "./bash.project.constructive.ts";
import { bashReviewCompoundPack } from "./bash.review.compound.ts";
import { bashReviewRiskyPack } from "./bash.review.risky.ts";
import { bashSearchReadPack } from "./bash.search.read.ts";
import { bashShellBuiltinsPack } from "./bash.shell.builtins.ts";
import { bashStructureSafePack } from "./bash.structure.safe.ts";
import { bashSystemReadPack } from "./bash.system.read.ts";
import { bashVcsReadPack } from "./bash.vcs.read.ts";
import { bashVcsWritePack } from "./bash.vcs.write.ts";
import {
  piExtensionInspectPack,
  piExtensionNetworkResearchPack,
  piExtensionReviewBoundariesPack,
  piExtensionWorkflowPack,
} from "./pi.extension.inspect.ts";
import { piFileMutatePack } from "./pi.file.mutate.ts";
import { piHomeSafePack } from "./pi.home.safe.ts";
import { piInspectReadPack } from "./pi.inspect.read.ts";

/**
 * The built-in policy surface used for every mode. Mode controls only how a
 * review result is dispatched; it must not change which deterministic rules
 * are active. The former permissive additions are intentionally included here
 * so the default experience is broad while the sealed floor still wins.
 */
export const baselinePacks = [
  bashInspectCorePack,
  bashSearchReadPack,
  bashShellBuiltinsPack,
  bashSystemReadPack,
  bashVcsReadPack,
  bashVcsWritePack,
  bashStructureSafePack,
  bashReviewRiskyPack,
  bashReviewCompoundPack,
  piInspectReadPack,
  piFileMutatePack,
  piExtensionInspectPack,
  piExtensionReviewBoundariesPack,
  bashDevVerifyPack,
  bashPackagesCommonPack,
  bashProjectConstructivePack,
  bashCompoundReadPack,
  piExtensionWorkflowPack,
  bashNetworkReadPack,
  piExtensionNetworkResearchPack,
  piHomeSafePack,
] as const;
