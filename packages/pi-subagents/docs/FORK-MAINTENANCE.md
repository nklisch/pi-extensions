# Maintained-fork policy

`@nklisch/pi-subagents` is an unpublished, locally qualified MIT fork of
`@gotgenes/pi-subagents@18.0.3` from commit
`c76a294a777a990950da23fc06cb0caf51da7ac6`.

The fork retains upstream history, copyright notices, license, exports, Pi
extension behavior, peer ranges, and package layout. Its intentional delta is the
documented ordered lifecycle-interceptor provider seam and its tests.

Before any future publication, maintainers must independently verify namespace
ownership and credentials, choose a release version, capture registry integrity
and tag/commit provenance, run the package and consumer qualification suites on
Node 24, and explicitly authorize publication. Local artifacts do not establish
published provenance or production capability.

Fork maintainers monitor `gotgenes/pi-packages` for subagent releases and security
reports. Rebase the narrow generic commits onto a current verified upstream
release before each fork update; contribute the generic seam upstream when the
proven contract is ready. Returning to upstream must change package selection only,
not lifecycle semantics or consumer contracts.
