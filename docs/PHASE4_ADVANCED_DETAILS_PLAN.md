# Phase 4 Plan: Advanced Monitor Details (Updated 2026-03-21)

## Current State

Phase 4 is **mostly implemented in backend/data terms** and **partially implemented in frontend UX terms**.

Already implemented:
- `GET /api/services/:id/details`
- `GET /api/services/:id/incidents`
- `GET /api/services/:id/regions/latest`
- rollups, incidents, degradation, and regional persistence
- modal tabs, recent diagnostics, and regional map rendering

Still missing or incomplete:
- frontend is not using `/details` as the main aggregate source yet
- incident history UI is still shallow
- regional diagnostics are useful but not fully operator-grade
- loading/error/empty states in the detail surface can be more granular

## Remaining Goal

When a service card is opened, the operator should immediately understand:
1. current state,
2. recent history,
3. geographic behavior,
4. multi-window reliability.

## Remaining Work

### A. Use the aggregate details payload first
- switch detail rendering to use `/api/services/:id/details` as the primary source
- surface `monitoredSince`, interval, last check source, and last check reason
- render 24h, 7d, 30d, 365d, and total uptime directly from that payload

### B. Add explicit incident history UX
- render `/api/services/:id/incidents` in a dedicated panel or stronger section
- show start, end, duration, reason, and source clearly
- support pagination or incremental loading

### C. Upgrade regional diagnostics
- keep the map
- add a clearer list/table with status, latency, source, and age
- make empty and partial regional data easier to interpret

### D. Harden the UI contract
- validate payload shapes defensively
- avoid whole-modal failure when one section fails
- add stable loading/empty/error states per section

## Acceptance Criteria

- `/details` is the primary detail data source
- uptime windows are visible without manual inference
- incident history is explicit and readable
- regional state is understandable in both map and list form
- partial data failures do not break the entire detail surface

## Non-Goals

- alert routing
- public status page theming
- org/role management
