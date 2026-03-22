# uptime-monitor

A self-hosted uptime monitoring dashboard built with Node.js, Express, SQLite, and vanilla JavaScript.
It checks your services through the Globalping API and shows live status, response-time history, and rolling 24h uptime.

---

## Project Vision

Build a **beautiful, self-hostable status page** that gives instant clarity at a glance.

- Designed for always-on visibility (including TV/dashboard displays)
- Calm, modern, and pleasing UI that stays readable over long viewing sessions
- Uses Globalping's existing global probe network instead of requiring users to manage distributed infrastructure
- Aims to deliver paid-tool-level value with a free, self-hosted, ownership-first approach

---

## Current Status

This project is currently **working and usable** for local/self-hosted monitoring.

### What works right now
- User authentication (register/login with JWT)
- Protected service management (create, edit, delete, list)
- Background scheduler that performs checks on intervals
- Response-time sparkline and detail chart (last 30 checks)
- 24h uptime percentage derived from `status_history`
- Multi-location monitoring payload support (country + local server option)
- Automatic Globalping failover to local checks + explicit local-only mode
- Incident lifecycle fields (`active_incident_since`, `last_incident_*`) tracked per service
- Per-check event metadata (`check_reason`, `timed_out`, `check_source`) stored and visible in modal
- Degradation lifecycle fields (`active_degradation_since`, `last_degradation_*`) tracked per service
- Daily rollups for low-footprint long-term uptime retention
- Automated regression tests for auth, services, and tools routes (36 tests passing)
- Per-service monitor config details in modal (type, interval, monitored since)
- Uptime windows (24h, 7d, 30d, 1y, all-time) and incident history in detail modal
- Webhook alert system: per-service alerts toggle, CRUD webhook management, HMAC-signed delivery

### Known limitations
- Scheduler timers are in-memory (rebuilt on restart)
- `status_history_regions` has no dedicated retention pruning yet
- Rich historical analytics view is planned separately (rollup backend foundation exists)

---

## Tech Stack

- **Backend:** Node.js, Express
- **Database:** SQLite (`database.sqlite`)
- **Auth:** JWT + bcrypt
- **Frontend:** HTML + Tailwind CDN + vanilla JS + Chart.js
- **Monitoring provider:** Globalping API

---

## Quick Start

### 1) Install dependencies
```bash
npm install
```

### 2) Configure environment
Create `.env` in the project root (or copy from `.env.example`):

```env
JWT_SECRET=change-this-to-a-strong-random-secret
GLOBALPING_API_KEY=
PORT=3000
ENABLE_LOCAL_FALLBACK=true
FORCE_LOCAL_ONLY_MODE=false
GLOBALPING_FAILOVER_THRESHOLD=3
GLOBALPING_RECOVERY_SUCCESS_THRESHOLD=2
GLOBALPING_RECOVERY_PROBE_INTERVAL_MS=120000
DEGRADATION_RESPONSE_TIME_MS=1200
RAW_HISTORY_RETENTION_DAYS=120
PASSWORD_MIN_LENGTH=0
TOOLS_DEFAULT_TIMEOUT_MS=5000
TOOLS_MAX_TIMEOUT_MS=20000
TOOLS_TRACEROUTE_MAX_HOPS=20
TOOLS_MTR_REPORT_CYCLES=5
TOOLS_MAX_PACKET_COUNT=10
```

Notes:
- `JWT_SECRET` should be long and random.
- `GLOBALPING_API_KEY` is optional; without it, anonymous Globalping access limits apply.
- `FORCE_LOCAL_ONLY_MODE=true` forces all checks to run locally and skips Globalping.
- The dashboard shows a warning banner when running in failover/local-only mode.
- `DEGRADATION_RESPONSE_TIME_MS` controls when successful checks are still classified as degraded.
- Raw `status_history` is retention-limited via `RAW_HISTORY_RETENTION_DAYS`, while `daily_rollups` preserve long-term stats.
- `PASSWORD_MIN_LENGTH` controls account password minimum length (set `0` to disable enforcement).
- `TOOLS_*` variables control diagnostics page limits and defaults.

### 3) Start the app
```bash
node server.js
```

### 4) Open in browser
`http://localhost:3000`

### 5) First run
- Sign up with a new email/password
- Log in and add your first service monitor

### 6) TV mode (read-only)
- Open `http://localhost:3000/tv` after signing in.
- TV mode auto-refreshes every 30 seconds and is optimized for distance readability.

---

## How It Works

### End-to-end flow
1. User logs in and receives JWT.
2. Frontend stores token and sends it via `Authorization: Bearer <token>`.
3. User creates a service (`name`, `type`, `target`, `interval`, `locations`).
4. Backend stores service and schedules the first check.
5. Scheduler calls Globalping, records result in `status_history`, updates service status fields.
6. UI refreshes every 30s and renders status, sparkline, uptime, and detail modal chart.

### Backend architecture
- `server.js` boots Express, static files, API routes, and scheduler initialization.
- `src/config/database.js` opens SQLite and runs schema migrations via `PRAGMA user_version`.
- `src/routes/auth.js` handles registration/login.
- `src/middleware/auth.js` enforces JWT auth for protected routes.
- `src/routes/services.js` handles service CRUD + history/events/rollups/details/incidents/regions endpoints.
- `src/routes/tools.js` handles on-demand diagnostics jobs (HTTP/DNS/Ping/Traceroute/MTR).
- `src/routes/webhooks.js` handles webhook CRUD and test delivery.
- `src/services/scheduler.js` manages timers and monitoring checks.
- `src/services/alerts.js` dispatches HMAC-signed webhook payloads on service state transitions.

### Frontend architecture
- `public/js/main.js` wires global delegated click/submit handlers.
- `public/js/auth.js` handles auth workflow and auth state changes.
- `public/js/api.js` centralizes authenticated fetch + `401` handling.
- `public/js/ui.js` renders cards/charts/modal, settings, and manage-service form UX.
- `public/js/tv.js` powers the read-only TV command-center view.
- `public/css/index.css` and `public/css/tv.css` are the active page stylesheets.

---

## API Overview

### Auth
- `POST /api/register`
- `POST /api/login`
- `GET /api/account`
- `PUT /api/account/email`
- `PUT /api/account/password`

### Services (auth required)
- `GET /api/services`
- `GET /api/services/meta/monitoring`
- `GET /api/services/:id`
- `GET /api/services/:id/history`
- `GET /api/services/:id/events`
- `GET /api/services/:id/rollups`
- `GET /api/services/:id/details`
- `GET /api/services/:id/incidents`
- `GET /api/services/:id/regions/latest`
- `POST /api/services`
- `PUT /api/services/:id`
- `DELETE /api/services/:id`

### Tools (auth required)
- `POST /api/tools/run`
- `GET /api/tools/jobs/:id`
- `POST /api/tools/jobs/:id/stop`

### Webhooks (auth required)
- `GET /api/webhooks`
- `POST /api/webhooks`
- `PUT /api/webhooks/:id`
- `DELETE /api/webhooks/:id`
- `POST /api/webhooks/:id/test`

### Health
- `GET /api/health`

---

## Data Model (Summary)

### `users`
- `id`, `email`, `password_hash`

### `services`
- `id`, `user_id`, `name`, `type`, `target`, `interval`, `locations`
- `status`, `lastChecked`, `lastResponseTime`, `uptime_24h`
- `alerts_enabled`, incident/degradation lifecycle fields

### `status_history`
- `id`, `service_id`, `timestamp`, `status`, `response_time`
- `check_source`, `is_degraded`, `timed_out`, `check_reason`

### `webhooks`
- `id`, `user_id`, `name`, `url`, `secret` (nullable), `events` (JSON array)
- `is_active`, `created_at`

### `daily_rollups`
- Long-term uptime buckets, pruned independently of raw `status_history`

---

## Project Structure

```text
server.js
src/
	config/database.js
	middleware/auth.js
	routes/auth.js
	routes/services.js
	routes/tools.js
	routes/webhooks.js
	services/scheduler.js
	services/alerts.js
public/
	index.html
	tv.html
	css/index.css
	css/tv.css
	js/main.js
	js/auth.js
	js/api.js
	js/ui.js
	js/tv.js
tests/
	auth.test.js
	services.test.js
	tools.test.js
```

---

## Manual Smoke Test Checklist

- Register a new user
- Log in successfully
- Add a monitor (with at least one location)
- Confirm status appears and updates over time
- Open detail modal and verify chart/downtime list
- Edit monitor and confirm scheduling still works
- Delete monitor and confirm it disappears

### Phase 1 Verification (Failover + Local Mode)

- Normal mode: with valid Globalping access, checks run and `Check Source` shows `Globalping`
- Auto-failover: simulate Globalping failure and verify warning banner appears and checks continue via `Local`
- Forced local-only: set `FORCE_LOCAL_ONLY_MODE=true`, restart app, verify all checks run as `Local`
- Recovery path: restore Globalping access and verify mode returns to normal after recovery threshold
- Incident metadata: when service is down, verify active incident duration and last incident reason are visible

---

## Roadmap (Phased)

### Phase 1 — Monitoring Accuracy (Implemented)
- Parse Globalping measurement result bodies to determine true up/down semantics
- Add basic incident lifecycle fields (start/end/reason/duration)
- Add request/input validation for service create/update payloads
- Add local failover + forced local-only mode with dashboard warning banner

### Phase 2 — At-a-Glance Dashboard UX (Implemented)
- Add top summary strip (total services, up, down, degraded, last check time)
- Sort and surface critical services first
- Improve loading/empty/error states for calmer and clearer UX

### Phase 3 — TV Mode (Dedicated View) (Implemented)
- Separate **TV mode route/view** at `/tv`, optimized for distance readability
- Larger typography, high-contrast status cards, summary strip, and warning visibility
- Auto-refresh with command-center telemetry (clock panel, refresh countdown, event stream)
- Fullscreen support via button and keyboard shortcut (`F`)

### Phase 4 — Advanced Monitor Details (Implemented)
- Replace generic click modal with a richer drilldown page/panel per service
- Include monitor details table (monitor age, interval, timeout, check source)
- Add uptime windows (24h, 7d, 30d, year, total) and incident summaries
- Add per-location status table with current/recent response and last check age
- Add optional regional/world response visualization layer

### Phase 5 — Alerts and Integrations (Implemented)
- Webhook CRUD management in Settings (name, URL, HMAC secret, event filter, active toggle)
- Per-service alerts toggle in service create/edit form
- HMAC-SHA256 signed outbound payloads with `X-Webhook-Signature` header
- Dispatches `service.down`, `service.recovered`, `service.degraded` events
- Built-in SSRF protection on webhook URLs (blocks localhost/private IP ranges)
- Test delivery endpoint with `X-Webhook-Test: true` header

### Phase 6 — Reliability and Testability
- Harden scheduler behavior around restart/retry/overlap scenarios
- Add basic route/service tests for auth and monitoring flows
- Add structured logging and consistent API error envelopes

### Phase 7 — Tools Command Suite (Core Implemented)
- Dedicated tools page for DNS, HTTP, Ping, Traceroute, and MTR diagnostics
- Multi-location result map + per-step live output
- Page-lifecycle stop behavior with explicit job stop endpoint
- In-memory job retention with safety timeout cleanup

### Detailed Build Plan for Phase 4
1. **Data foundation:** store check source, incident boundaries, and aggregate uptime windows.
2. **Backend APIs:** add a `service details` endpoint with overview, regional snapshots, and incident timeline.
3. **UI shell:** replace current simple modal with tabbed detail view (`Overview`, `Regions`, `Incidents`).
4. **Regional UX:** render location table first, then map visualization as enhancement.
5. **Performance pass:** cache derived metrics and keep dashboard refresh lightweight.

---

## Contributing / Agent Notes

See `AGENTS.md` for implementation guardrails, migration rules, and architecture constraints used for ongoing development.

---

## Next Priorities (2026-05-01)

1. Expand webhook system: Discord/Slack preset URLs, alert cooldown/de-duplication to prevent flapping noise.
2. Add retention/index strategy for `status_history_regions` and incident-heavy queries.
3. Promote per-region detail view (`/api/services/:id/regions/latest`) in the modal Diagnostics tab.
4. Add Tools page improvements: better Ping output formatting, fix HTTP/DNS/MTR validation errors.
5. Scheduled silence/maintenance windows to suppress alerts during planned downtime.

### Recommended order

- **First:** retention/indexing
- **Second:** alert cooldown/dedup
- **Third:** per-region UI
- **Fourth:** tools UX fixes
- **Fifth:** maintenance windows
