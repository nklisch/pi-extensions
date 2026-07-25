import {
  DiagnosticSchema,
  ErrorCodeSchema,
  type Diagnostic,
  type DomainContractErrorInput,
} from "./error-contract.js";
import { PluginKeySchema } from "./identity.js";
import { JsonValueSchema } from "./schema.js";
import { SourceLocationSchema } from "./provenance-location.js";

/** Common typed error behavior shared by boundary failures and claim conflicts. */
export class DomainContractError extends Error {
  readonly code: DomainContractErrorInput["code"];
  readonly operation: string;
  readonly location?: DomainContractErrorInput["location"];
  readonly plugin?: DomainContractErrorInput["plugin"];
  readonly details?: DomainContractErrorInput["details"];

  constructor(input: DomainContractErrorInput) {
    super(
      input.message,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "DomainContractError";

    this.code = ErrorCodeSchema.parse(input.code);
    this.operation = input.operation;
    if (input.location !== undefined) {
      this.location = SourceLocationSchema.parse(input.location);
    }
    if (input.plugin !== undefined) {
      this.plugin = PluginKeySchema.parse(input.plugin);
    }
    if (input.details !== undefined) {
      this.details = JsonValueSchema.parse(input.details);
    }

    if (typeof input.operation !== "string" || input.operation.length === 0) {
      throw new TypeError("DomainContractError operation must be non-empty");
    }
    if (typeof input.message !== "string" || input.message.length === 0) {
      throw new TypeError("DomainContractError message must be non-empty");
    }
  }

  toDiagnostic(): Diagnostic {
    const diagnostic = {
      code: this.code,
      severity: "error" as const,
      operation: this.operation,
      message: this.message,
      ...(this.location === undefined ? {} : { location: this.location }),
      ...(this.plugin === undefined ? {} : { plugin: this.plugin }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
    return DiagnosticSchema.parse(diagnostic);
  }
}
