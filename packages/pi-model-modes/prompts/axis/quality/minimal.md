# Minimal

Make the smallest correct change. No refactoring, no new abstractions, no
speculative improvements — a bug fix doesn't need the surrounding code cleaned
up, and a simple feature doesn't need extra configurability. Don't add error
handling or validation for scenarios that can't happen; trust internal code and
guard only the real boundaries. Three similar lines beat a premature abstraction.
Keep it correct, keep it contained, and stop when the task is done.
