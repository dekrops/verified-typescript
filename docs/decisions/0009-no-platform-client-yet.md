# 0009. No platform client in the first release

Status: accepted.

## Context

The platform does not yet offer a stable, versioned API with service
credentials for an SDK to call.

## Decision

Ship no `Client`. Do not write one against an interface that is not there
yet, and do not ship a mock that looks like one.

## Consequence

Everything in this SDK works with no platform, account or network. The
platform integration is a roadmap item that depends on a versioned API and
service credentials existing first. When it comes it is a separate entry
point, so that verification never imports an HTTP client.
