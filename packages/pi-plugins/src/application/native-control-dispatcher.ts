import type { NativeControlDispatchContext } from "./ports/native-control-applications.js";
import type { NativeControlCommand, NativeControlCommandId } from "./native-control-registry.js";
import type { NativeControlDispatchResult } from "./native-control-projection.js";

export type NativeControlHandlerContext = Omit<NativeControlDispatchContext, "readiness"> &
  Readonly<{ readiness?: NativeControlDispatchContext["readiness"] }>;

export type NativeControlCommandHandler<K extends NativeControlCommandId> = (
  command: Extract<NativeControlCommand, { command: K }>,
  context: NativeControlHandlerContext,
  signal: AbortSignal,
) => Promise<NativeControlDispatchResult>;

/** Every grammar command must have exactly one dispatch owner. */
export type NativeControlHandlerMap = Readonly<{
  [K in NativeControlCommandId]: NativeControlCommandHandler<K>;
}>;

type ReadDispatcher = Readonly<{
  dispatch(command: NativeControlCommand, signal: AbortSignal): Promise<NativeControlDispatchResult | undefined>;
}>;
type MutationDispatcher = Readonly<{
  dispatch(command: NativeControlCommand, context: NativeControlDispatchContext, signal: AbortSignal): Promise<NativeControlDispatchResult | undefined>;
}>;

async function required(result: Promise<NativeControlDispatchResult | undefined>, owner: "read" | "mutation"): Promise<NativeControlDispatchResult> {
  const value = await result;
  if (value === undefined) throw new TypeError(`native control ${owner} handler rejected its registered command`);
  return value;
}

/**
 * The exhaustive map is the routing authority. Read/mutation dispatchers own
 * workflow assembly only; adding a registry command fails typecheck here until
 * one owner is selected.
 */
export function createNativeControlHandlerMap(input: Readonly<{
  read: ReadDispatcher;
  mutation: MutationDispatcher;
}>): NativeControlHandlerMap {
  const read = <K extends NativeControlCommandId>(command: Extract<NativeControlCommand, { command: K }>, _context: NativeControlHandlerContext, signal: AbortSignal) =>
    required(input.read.dispatch(command, signal), "read");
  const mutation = <K extends NativeControlCommandId>(command: Extract<NativeControlCommand, { command: K }>, context: NativeControlHandlerContext, signal: AbortSignal) => {
    if (context.readiness === undefined) throw new TypeError("native control mutation handler requires readiness admission");
    return required(input.mutation.dispatch(command, context as NativeControlDispatchContext, signal), "mutation");
  };

  const handlers = {
    presentation: read,
    help: read,
    grammar: read,
    "marketplace.add": mutation,
    "marketplace.remove": mutation,
    "marketplace.list": read,
    "marketplace.refresh": mutation,
    "marketplace.adopt.preview": read,
    "marketplace.adopt.import": mutation,
    browse: read,
    "inspection.list": read,
    "inspection.show": read,
    "inspection.diagnose": read,
    "install.open": mutation,
    "install.apply": mutation,
    "install.recover": mutation,
    "install.run": mutation,
    "lifecycle.enable": mutation,
    "lifecycle.disable": mutation,
    "lifecycle.update": mutation,
    "lifecycle.uninstall": mutation,
    "project.sync": mutation,
    "updates.status": read,
    "updates.policy.preview": read,
    "updates.policy.apply": mutation,
    "updates.policy.set": mutation,
    "updates.notices.list": read,
    "updates.notices.acknowledge": mutation,
    "updates.automatic.run": mutation,
    "config.host-precedence": mutation,
    status: read,
    "operation.status": read,
    "operation.cancel": read,
  } satisfies NativeControlHandlerMap;
  return Object.freeze(handlers);
}

export function dispatchNativeControlCommand(
  handlers: NativeControlHandlerMap,
  command: NativeControlCommand,
  context: NativeControlHandlerContext,
  signal: AbortSignal,
): Promise<NativeControlDispatchResult> {
  // The key and discriminant are correlated by NativeControlHandlerMap. The
  // cast is local to this dispatcher because TypeScript cannot preserve that
  // correlation through computed property access.
  const handler = handlers[command.command] as NativeControlCommandHandler<NativeControlCommandId>;
  return handler(command as never, context, signal);
}
