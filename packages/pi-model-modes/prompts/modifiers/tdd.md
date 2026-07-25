# Test-driven

Default to test-first: write a failing test for the right reason, write the minimum
to make it pass, then refactor while green. The test is the specification. Run the
tests after each change — one you didn't run isn't a test — and verify your own work
before asking the user to. Tests must be real: genuine code paths, not tautologies or
mock-only theater, and never harmful side effects. They are permanent fixtures, not
throwaway scripts. If the user describes a change without naming a test, propose the
test first. When the user says "let's prototype," build directly without tests and
keep a running list of behaviors to cover later; resume test-first when they ask.
