import {
  BASH_STAGE_COMPOSITION_FAMILIES,
  BASH_STAGE_REDIRECT_TOLERANT_FAMILIES,
  BASH_STRUCTURE_COLON_NOOP_FAMILY,
  BASH_STRUCTURE_TRUE_NOOP_FAMILY,
} from "./composition-families.ts";
import { defineShippedPack } from "./define.ts";
import { BENIGN_REDIRECT_STRUCTURE } from "./redirect-safety.ts";

const rawPack = {
  version: 1,
  id: "bash.structure.safe",
  rules: [
    {
      id: "bash.structure.safe:review-tail-follow-stage",
      effect: "review",
      match: {
        stageSome: {
          all: [
            { program: "tail" },
            { any: [{ flagPresent: "f" }, { flagPresent: "follow" }] },
          ],
        },
      },
      reason: "tail follow mode in a composed command requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.structure.safe:review-sort-output-stage",
      effect: "review",
      match: {
        stageSome: {
          all: [
            { program: "sort" },
            { any: [{ flagPresent: "o" }, { flagPresent: "output" }] },
          ],
        },
      },
      reason: "sort output flag in a composed command writes to disk",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.structure.safe:review-find-mutating-stage",
      effect: "review",
      match: {
        stageSome: {
          all: [
            { program: "find" },
            {
              any: [
                { flagPresent: "delete" },
                { flagPresent: "exec" },
                { flagPresent: "execdir" },
                { flagPresent: "ok" },
                { flagPresent: "okdir" },
              ],
            },
          ],
        },
      },
      reason:
        "find mutation or execution action in a composed command requires review",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.structure.safe:allow-read-only-benign-redirect",
      effect: "allow",
      match: {
        all: [
          {
            composition: {
              stage: { any: [...BASH_STAGE_REDIRECT_TOLERANT_FAMILIES] },
              operators: ["and", "seq"],
              allowBackground: false,
              orFallback: ["true", ":"],
            },
          },
          BENIGN_REDIRECT_STRUCTURE,
        ],
      },
      reason:
        "read-only or verification output redirect stays within temp/project scope",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.structure.safe:allow-read-only-composition",
      effect: "allow",
      match: {
        composition: {
          stage: { any: [...BASH_STAGE_COMPOSITION_FAMILIES] },
          operators: ["and", "seq"],
          allowBackground: false,
          minStages: 2,
          orFallback: ["true", ":"],
        },
      },
      reason:
        "every stage independently matches a read-only/dev-verify allow family; || only before a final bare true/:",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.structure.safe:allow-true-noop",
      effect: "allow",
      match: BASH_STRUCTURE_TRUE_NOOP_FAMILY,
      reason: "true no-op command",
      provenance: { source: "shipped" },
    },
    {
      id: "bash.structure.safe:allow-colon-noop",
      effect: "allow",
      match: BASH_STRUCTURE_COLON_NOOP_FAMILY,
      reason: "colon no-op command",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const bashStructureSafePack = defineShippedPack(rawPack);
