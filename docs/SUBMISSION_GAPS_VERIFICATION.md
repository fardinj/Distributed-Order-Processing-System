# Follow-up verification — 2026-11-08

This follow-up closes gaps found by comparing the implementation with the hiring task. Work uses `feature/submission-gaps-and-readme` from `develop`. Existing data, credentials, financial obligations and audit history are retained.

## Implemented changes

- Customer/admin order lists now accept status and ISO timestamp bounds, with existing cursor pagination and owner checks. The interval is `[createdFrom, createdTo)`; invalid states/dates and reversed or empty ranges return 400. Admin UUID search combines with the filters.
- `GET /api/orders/:id/events` exposes bounded oldest-first pages of the complete retained history. A database identity sequence preserves new event insertion order, including events in the same transaction. Existing events are backfilled without changing their content; missing historical events are not invented.
- Fulfillment commits `ItemProcessingStarted` alongside each completed/failed/retry attempt. Physical fulfillment commits `ShipmentCreated` with its reference. Both participate in the same rollback boundary as the related state/effect.
- Protected Prometheus-format metrics expose SQL-backed admission, backlog, retry/review and financial observations plus process memory/CPU/uptime and HTTP response-class counters. Collection uses existing owner pools and a five-second single-flight cache. No cross-owner queries, high-cardinality customer labels, extra steady services or relaxed authentication were introduced.
- Design status/diagrams and current API/runbook documentation now match the implementation. README separates setup from checks and links the assumptions, design, APIs, operations and actual evidence.

Commerce migration 013 adds event sequence and filter/metric indexes. Billing migration 009 adds financial metric indexes. Bank remains at six migrations. Changes are additive; applied migration files were not edited.

## Forced worker crashes

```powershell
powershell -NoProfile -File scripts/verification/crash.ps1
```

The runner prepares paid, individually deferred fixture orders, stops the normal Commerce worker, and starts a disposable replica. The replica alone receives two opt-in environment settings and a private file control targeting one item/phase. No HTTP request or customer DTO can select a fault. Normal Compose services have neither setting nor control mount.

The private hook pauses immediately after local effect SQL, before commit, or immediately after the processing transaction commits. The runner observes the marker and sends a real `SIGKILL`; each stopped container reported **exit 137, not running**. It then checks committed SQL state, removes only the disposable container, restores normal Commerce and waits for recovery. For after-commit cases it also replays the local job to exercise success guards.

| Processor | After effect SQL, before commit | After commit, before worker continuation |
|---|---|---|
| DIGITAL | Zero committed grants/attempts after kill; recovery produced one grant/attempt | One committed grant/attempt survived; replay added none |
| SUBSCRIPTION | Zero committed extensions/attempts after kill; recovery produced one extension/attempt | One committed extension/attempt survived; replay added none |
| PHYSICAL | Allocation remained ALLOCATED, no shipment/attempt; recovery consumed once | CONSUMED allocation and one shipment/attempt survived; replay added none |

All six fixtures ended COMPLETED with **one exact 100-IRR Billing payment and Bank charge**, one typed effect, one committed attempt, and a released admission slot. Physical fixtures started with two units, reserved one, and ended with exactly one sellable unit. No ledgers or owed refunds were reset.

These are deterministic local fulfillment boundaries, not random-time kills or every transport crash point. RabbitMQ acknowledges a durable SQL inbox handoff before later SQL-owned fulfillment, so there is no per-item broker acknowledgment at this commit point. Earlier checkout tests separately cover duplicate/stale delivery, publisher lease recovery and durable inbox handoff. This report does not claim a forced kill at every publisher/inbox commit-to-ACK instruction.

## API and history checks

```sh
docker compose --profile tools run --rm --volume ./scripts/verification:/workspace/scripts/verification:ro submission-checks submission-gaps
```

Passed against real OIDC, PostgreSQL, RabbitMQ and the running Gateway:

- One order containing all three types completed; another was cancelled. Status/date filtering and limit-one pagination included the matching order and excluded the cancelled order. Admin UUID search combined with filters; another customer's list did not expose it.
- Invalid status and reversed date range returned 400; `createdTo` was checked as an exclusive boundary.
- Three item-start events, one shipment-created event and terminal item events were present in insertion order.
- An identified order received 111 private verification history entries to force paging past the detail window. All **124 retained events** were returned across 17-entry pages, with exactly matching SQL identities/order and no omissions or duplicates.
- Customer B received 404 for Customer A's history; an unrelated-order cursor and limit 101 returned 400. Admin history reads succeeded.
- Admin Commerce metrics and private service-authenticated Billing metrics returned valid text. Customer/anonymous access was denied; Gateway did not route private metrics. No order UUID appeared in the metric output.

Raw reports remain private under `.local/verification/`: `submission-gaps.json` and six `crash-<type>-<phase>.json` files. Only the known nonsecret barrier-control directory is writable by the disposable worker; it contains item IDs and markers, not credentials.

## Regression checks

| Command/check | Result |
|---|---|
| `docker compose --profile tools run --rm --build tools npm test` | Build/client generation succeeded; 16 tests passed, including filter validation and metric cache failure/recovery/concurrent-reader checks. |
| `tools npm run validate:schemas` / `tools npm run format:check` | All three schemas and source formatting passed. |
| `checkout-checks` | Repeated creation, stock contention, expiry/revision, SQL admission, duplicate/poison messages, publisher recovery, lock-timeout rollback and durable inbox retention passed. |
| `fulfillment-checks` | Typed effects, concurrent subscription renewal, rollback/retry, partial/full/unknown/declined returns, large exact IRR, cancellation cutoff and SQL effect/budget guards passed with the new history entries. |
| `recovery-checks` | Redis behavior, owner/cancellation races, fifth-attempt recovery, durable review and guarded audited manual cycle passed. |
| `foundation-checks` | Real OIDC/PKCE/roles/ownership, huge money, versioned inventory, private owner permissions and immutable evidence passed. |
| `git diff --check`, runner parse and document links | Checked before integration; local ignored source files were verified to remain on disk. |

The crash marker is published through a same-directory atomic rename so a kill cannot expose a partially written marker. After that harness improvement, the digital before-commit check was repeated. Controls now allow selecting `-Types`/`-Phases` for a focused rerun; defaults still exercise all six combinations. The runner restores normal Commerce in `finally` and releases its known fixture deferral if an intermediate assertion fails.

## Repository hygiene

The original hiring Markdown and `.impeccable/design.json` were removed from the Git index with `git rm --cached` and retained on disk. Git/Docker ignore rules exclude the brief, its local PDF, scratch `temp.txt` and local UI-tool metadata. Source code, migrations, design documents and useful repository workflow instructions remain tracked. Secrets, raw reports, backup dumps and generated clients were already ignored. Prior Git history is preserved; this is untracking, not history rewriting.

## Limits

The dedicated 8-GB/four-core soak, a fresh mixed-workload saturation benchmark, real provider integrations, distributed tracing, a monitoring collector/dashboard and production TLS remain unimplemented or unmeasured as previously disclosed. New metrics do not turn the earlier sampled load run into continuous performance evidence. Historical pre-migration events retain their original facts; backfilled sequence values do not reconstruct missing timestamps or events.
