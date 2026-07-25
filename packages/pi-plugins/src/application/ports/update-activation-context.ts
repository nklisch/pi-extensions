/** Pi 0.80.x supplies reload only inside a live command operation context. */
export interface UpdateActivationContextPort {
  availability(): "available" | "unavailable";
}
