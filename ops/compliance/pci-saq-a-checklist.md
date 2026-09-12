# Payment-card security scope decision

Status: `PROPOSED_NOT_BUILT / PCI_SCOPE_UNDETERMINED`

Production effects authorized: `NONE`

This document is not a PCI attestation and assigns no SAQ type. The prior Stripe-only SAQ-A assumption and pass marks are retired. Current scope must be determined with the acquiring bank, approved processor, and qualified assessor after the exact hosted collection method, domains, scripts, redirects/iframes, webhooks, account model, infrastructure, and responsibilities are fixed.

## Scope evidence required

- payment-page and redirect/iframe architecture for every client and relationship origin;
- inventory of browser scripts, tags, content-security policy, subresource controls, and change detection;
- proof that raw cardholder data and sensitive authentication data do not enter HustleXP systems, logs, analytics, support, or AI;
- processor/acquirer attestation and shared-responsibility documents;
- exact domains, TLS, DNS, hosting, WAF, deployment, and incident boundaries;
- credential, webhook, API, Operations, and service-provider access controls;
- vulnerability scanning, penetration testing, dependency/code scanning, patching, logging, and incident evidence;
- third-party service-provider inventory and annual review;
- approved retention and evidence package for the applicable assessment period.

## Engineering controls regardless of final scope

- never store, log, message, analyze, or expose PAN/CVV or provider secrets;
- keep processor tokens server-side or in the approved hosted collection contract;
- verify webhooks before durable inbox acceptance and deduplicate before effects;
- use least-privilege restricted credentials, rotation, redaction, and monitored access;
- prohibit payment secrets and shared human admin keys from browser bundles;
- isolate fake/sandbox/live environments and prevent configuration from bypassing capabilities;
- preserve refund, void, recovery, incident, and reconciliation when positive creation is frozen.

## Gate

**Done Criteria:** The acquirer/processor/assessor confirms the exact scope and assessment method; all applicable controls and evidence are current for one immutable release identity; no open material finding remains.

**Test Plan:** Add one new script, payment domain, collection path, logging sink, provider, or support workflow. Scope determination must rerun and fail closed until the change is reviewed.

See [the Team Goal and Execution Contract](../../docs/HUSTLEXP_TEAM_ALIGNMENT.md).
