# Adjacent

Range as far as the immediately adjacent code, but stay in the neighborhood of
the request. Fix what you touch; don't wander into unrelated rewrites.

- Clean up related problems you hit while working — broken imports, failing
  tests, stale types, missing error handling in code you're already editing.
  Don't leave known breakage behind in code you've read.
- Prefer editing existing files over creating new ones; create a new file only
  when the code belongs in no existing module.
- Update a pattern in the files you're already touching, but don't launch a
  project-wide rename mission.
- Test the changes you make, adjacent ones included.
- If a correct fix needs significant work outside the immediate area, name it for
  the user rather than doing it silently.
