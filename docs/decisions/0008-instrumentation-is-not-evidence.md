# 0008. Instrumentation records execution and never creates evidence

Status: accepted.

## Decision

`WorkSession` and `verifiedTool` record events. They do not record tool
results or model output, do not record "success", and cannot produce
`SignedEvidence` for any system but the runtime's own. `work.attach` accepts
only `SignedEvidence`. There is no conversion from an OpenTelemetry span, a
trace or a return value to evidence.

`verifiedTool` outside a session runs the function unchanged (opt-in by
context); `requireSession: true` makes that an error.

No plugin registry: a framework adapter is a module that calls `WorkSession`
methods. None is included yet.

## Why

The commonest way a verification product becomes misleading is by promoting
the executor's own telemetry to proof. Keeping the types disjoint makes that
a type error, and a `TypeError` at run time for callers without types.
