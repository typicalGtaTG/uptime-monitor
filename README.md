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

### Known limitations
- Scheduler timers are in-memory (rebuilt on restart)
- No automated test suite yet

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
```

Notes:
- `JWT_SECRET` should be long and random.
- `GLOBALPING_API_KEY` is optional; without it, anonymous Globalping access limits apply.
- `FORCE_LOCAL_ONLY_MODE=true` forces all checks to run locally and skips Globalping.
- The dashboard shows a warning banner when running in failover/local-only mode.

### 3) Start the app
```bash
node server.js
```

### 4) Open in browser
`http://localhost:3000`

### 5) First run
- Sign up with a new email/password
- Log in and add your first service monitor

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
- `src/routes/services.js` handles service CRUD + history endpoint.
- `src/services/scheduler.js` manages timers and monitoring checks.

### Frontend architecture
- `public/js/main.js` wires global delegated click/submit handlers.
- `public/js/auth.js` handles auth workflow and auth state changes.
- `public/js/api.js` centralizes authenticated fetch + `401` handling.
- `public/js/ui.js` renders cards/charts/modal and manage-service form UX.

---

## API Overview

### Auth
- `POST /api/register`
- `POST /api/login`

### Services (auth required)
- `GET /api/services`
- `GET /api/services/:id`
- `GET /api/services/:id/history`
- `POST /api/services`
- `PUT /api/services/:id`
- `DELETE /api/services/:id`

---

## Data Model (Summary)

### `users`
- `id`, `email`, `password_hash`

### `services`
- `id`, `user_id`, `name`, `type`, `target`, `interval`, `locations`
- `status`, `lastChecked`, `lastResponseTime`, `uptime_24h`

### `status_history`
- `id`, `service_id`, `timestamp`, `status`, `response_time`

---

## Project Structure

```text
server.js
src/
	config/database.js
	middleware/auth.js
	routes/auth.js
	routes/services.js
	services/scheduler.js
public/
	index.html
	js/main.js
	js/auth.js
	js/api.js
	js/ui.js
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

### Phase 2 — At-a-Glance Dashboard UX (Next)
- Add top summary strip (total services, up, down, degraded, last check time)
- Sort and surface critical services first
- Improve loading/empty/error states for calmer and clearer UX

### Phase 3 — TV Mode (Dedicated View)
- Introduce a separate **TV mode view/route** optimized for distance readability
- Larger typography, simplified controls, higher contrast status chips
- Auto-refresh + low-distraction layout designed for always-on displays

### Phase 4 — Advanced Monitor Details (Planned)
- Replace generic click modal with a richer drilldown page/panel per service
- Include monitor details table (monitor age, interval, timeout, check source)
- Add uptime windows (24h, 7d, 30d, year, total) and incident summaries
- Add per-location status table with current/recent response and last check age
- Add optional regional/world response visualization layer

### Phase 5 — Alerts and Integrations
- Add outbound notifications (webhook-first, then email/Discord/Slack)
- Add per-service alert rules and cooldown/de-duplication behavior

### Phase 6 — Reliability and Testability
- Harden scheduler behavior around restart/retry/overlap scenarios
- Add basic route/service tests for auth and monitoring flows
- Add structured logging and consistent API error envelopes

### Detailed Build Plan for Phase 4
1. **Data foundation:** store check source, incident boundaries, and aggregate uptime windows.
2. **Backend APIs:** add a `service details` endpoint with overview, regional snapshots, and incident timeline.
3. **UI shell:** replace current simple modal with tabbed detail view (`Overview`, `Regions`, `Incidents`).
4. **Regional UX:** render location table first, then map visualization as enhancement.
5. **Performance pass:** cache derived metrics and keep dashboard refresh lightweight.

---

## Contributing / Agent Notes

See `AGENTS.md` for implementation guardrails, migration rules, and architecture constraints used for ongoing development.
