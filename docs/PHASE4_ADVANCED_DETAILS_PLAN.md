# Phase 4 Plan: Advanced Monitor Details

## Goal
Move from a simple graph modal to a full monitor drilldown experience that gives deep operational context at a glance.

This phase is inspired by enterprise uptime tools, but adapted for this project's architecture and self-hosted model.

---

## UX Outcome (Target)
When a user clicks a service card, they should see:

1. **Monitor Details**
   - monitored since
   - last overall check
   - monitor frequency
   - timeout limit
   - check source status (global / failover / local-only)

2. **Uptime Windows**
   - 24h, 7d, 30d, yearly, total
   - active incident duration (if currently down)

3. **Regional Status**
   - per-location rows with current latency, recent trend, last check age
   - optional map visualization overlay for global points

4. **Incident Timeline**
   - recent incidents with start/end/duration/reason

---

## Backend Scope

### Data additions (additive migrations only)
- `status_history.check_source` (`globalping` | `local`)
- optional `status_history.location_label` (for regional rows)
- `service_incidents` table for historical incident records:
  - `id`, `service_id`, `started_at`, `ended_at`, `duration_ms`, `reason`, `resolved_by`

### API additions
- `GET /api/services/:id/details`
  - monitor metadata summary
  - uptime windows
  - active incident state
  - latest regional snapshot
- `GET /api/services/:id/incidents`
  - paginated incident history
- `GET /api/services/:id/regions`
  - current and recent per-location metrics

---

## Frontend Scope

### Navigation model
- Keep dashboard cards as-is for at-a-glance monitoring.
- Replace current lightweight modal with a richer service detail panel/page:
  - `Overview`
  - `Regions`
  - `Incidents`

### Rendering sequence
1. Ship table-based regional and incident views first.
2. Add map visualization after table data is stable.
3. Add micro-animations and transitions last.

---

## Delivery Steps

### Step A — Data groundwork
- store check source in history
- create incident table
- backfill defaults safely

### Step B — Aggregation services
- compute uptime windows from history efficiently
- compute incident durations
- provide regional snapshot normalization

### Step C — API endpoints
- add details/incidents/regions endpoints
- apply ownership checks
- return stable response contracts

### Step D — UI implementation
- build detail shell with tab navigation
- wire overview metrics
- wire regional table and incident list

### Step E — Visualization enhancement
- add optional world map for latest regional latencies
- preserve fast fallback when map library fails/disabled

### Step F — Hardening
- add endpoint tests for ownership and shape
- add manual smoke path covering all tabs

---

## Acceptance Criteria
- Clicking a card shows much more than a single generic graph.
- Users can identify where checks are passing/failing and why.
- Users can read 24h/7d/30d/total reliability without external tools.
- Incident history is understandable and actionable.
- Dashboard remains fast and readable while detail view is richer.

---

## Non-Goals (for this phase)
- Public status page theming customization
- Alert channels and escalations (handled in alerting phase)
- Multi-tenant/org role model
