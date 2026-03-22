// src/routes/services.js

const express = require('express');
const { db } = require('../config/database');
const authenticateToken = require('../middleware/auth');
const { scheduleNextCheck, cancelCheck, getMonitoringStatus } = require('../services/scheduler');

const router = express.Router();

const ALLOWED_SERVICE_TYPES = new Set(['http', 'ping', 'dns']);

function computeUptimeFromTotals(totalChecks, upChecks) {
    if (!totalChecks || totalChecks <= 0) return 100;
    return (upChecks / totalChecks) * 100;
}

function clampInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeLocations(locations) {
    if (!Array.isArray(locations)) return [];
    return locations
        .filter(location => location && typeof location === 'object')
        .map(location => ({
            value: String(location.value || '').trim().toUpperCase(),
            type: String(location.type || '').trim().toLowerCase()
        }))
        .filter(location => location.value && (location.type === 'country' || location.type === 'local'));
}

function validateServicePayload(payload) {
    const name = String(payload?.name || '').trim();
    const type = String(payload?.type || '').trim().toLowerCase();
    const target = String(payload?.target || '').trim();
    const interval = Number(payload?.interval);
    const locations = normalizeLocations(payload?.locations);

    if (name.length < 2 || name.length > 120) {
        return { error: 'Service name must be between 2 and 120 characters.' };
    }
    if (!ALLOWED_SERVICE_TYPES.has(type)) {
        return { error: 'Service type must be one of: http, ping, dns.' };
    }
    if (target.length < 2 || target.length > 255) {
        return { error: 'Target must be between 2 and 255 characters.' };
    }
    if (!Number.isInteger(interval) || interval < 30000 || interval > 86400000) {
        return { error: 'Interval must be an integer between 30000 and 86400000 milliseconds.' };
    }
    if (locations.length === 0) {
        return { error: 'At least one monitoring location is required.' };
    }

    const hasInvalidCountryCode = locations.some(location => location.type === 'country' && !/^[A-Z]{2}$/.test(location.value));
    if (hasInvalidCountryCode) {
        return { error: 'Country locations must use 2-letter country codes.' };
    }

    const hasInvalidLocalCode = locations.some(location => location.type === 'local' && location.value !== 'LOCAL');
    if (hasInvalidLocalCode) {
        return { error: 'Local location must use value LOCAL.' };
    }

    const alerts_enabled = payload?.alerts_enabled ? 1 : 0;

    return {
        value: {
            name,
            type,
            target,
            interval,
            locations,
            alerts_enabled
        }
    };
}

// All routes in this file are protected
router.use(authenticateToken);

router.get('/', (req, res) => {
    db.all('SELECT * FROM services WHERE user_id = ? ORDER BY name', [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Error fetching services.' });
        res.json(rows);
    });
});

router.get('/meta/monitoring', (_req, res) => {
    res.json(getMonitoringStatus());
});

router.get('/:id/details', (req, res) => {
    const serviceId = req.params.id;

    db.get('SELECT * FROM services WHERE id = ? AND user_id = ?', [serviceId, req.user.id], (serviceErr, service) => {
        if (serviceErr) return res.status(500).json({ error: 'Error fetching service details.' });
        if (!service) return res.status(404).json({ error: 'Service not found.' });

        const firstCheckSql = 'SELECT MIN(timestamp) AS monitored_since FROM status_history WHERE service_id = ?';
        const rollupsSql = `
            SELECT date, checks_total, checks_up, checks_down, checks_degraded, avg_response_time, max_response_time
            FROM daily_rollups
            WHERE service_id = ?
            ORDER BY date DESC
            LIMIT 1825`;
        const eventsSql = `
            SELECT timestamp, status, response_time, check_source, is_degraded, check_reason, timed_out
            FROM status_history
            WHERE service_id = ?
            ORDER BY timestamp DESC
            LIMIT 10`;
        const latestRegionalTimestampSql = `
            SELECT timestamp
            FROM status_history_regions
            WHERE service_id = ?
            ORDER BY timestamp DESC
            LIMIT 1`;

        db.get(firstCheckSql, [serviceId], (firstErr, firstCheck) => {
            if (firstErr) return res.status(500).json({ error: 'Error fetching monitor start date.' });

            db.all(rollupsSql, [serviceId], (rollupErr, rollupRows) => {
                if (rollupErr) return res.status(500).json({ error: 'Error fetching rollup data.' });

                db.all(eventsSql, [serviceId], (eventsErr, eventsRows) => {
                    if (eventsErr) return res.status(500).json({ error: 'Error fetching event data.' });

                    db.get(latestRegionalTimestampSql, [serviceId], (regionTsErr, latestRegionTsRow) => {
                        if (regionTsErr) return res.status(500).json({ error: 'Error fetching regional snapshot timestamp.' });

                        const latestTimestamp = latestRegionTsRow?.timestamp;
                        const regionalSql = latestTimestamp
                            ? `SELECT timestamp, location_label, location_code, status, response_time, check_source, reason
                               FROM status_history_regions
                               WHERE service_id = ? AND timestamp = ?
                               ORDER BY location_label ASC`
                            : null;

                        const onRegionalRows = (regionalRows) => {
                            const rows = Array.isArray(rollupRows) ? rollupRows : [];
                            const now = new Date();
                            const windows = {
                                last7d: { total: 0, up: 0 },
                                last30d: { total: 0, up: 0 },
                                last365d: { total: 0, up: 0 },
                                total: { total: 0, up: 0 }
                            };

                            rows.forEach(row => {
                                const dayDate = new Date(`${row.date}T00:00:00Z`);
                                const diffDays = Math.floor((now.getTime() - dayDate.getTime()) / (24 * 60 * 60 * 1000));

                                windows.total.total += row.checks_total;
                                windows.total.up += row.checks_up;

                                if (diffDays <= 7) {
                                    windows.last7d.total += row.checks_total;
                                    windows.last7d.up += row.checks_up;
                                }
                                if (diffDays <= 30) {
                                    windows.last30d.total += row.checks_total;
                                    windows.last30d.up += row.checks_up;
                                }
                                if (diffDays <= 365) {
                                    windows.last365d.total += row.checks_total;
                                    windows.last365d.up += row.checks_up;
                                }
                            });

                            const payload = {
                                service: {
                                    id: service.id,
                                    name: service.name,
                                    type: service.type,
                                    target: service.target,
                                    interval: service.interval,
                                    status: service.status,
                                    lastChecked: service.lastChecked,
                                    lastResponseTime: service.lastResponseTime,
                                    lastCheckSource: service.last_check_source,
                                    lastCheckReason: service.last_check_reason,
                                    monitoredSince: firstCheck?.monitored_since || null
                                },
                                uptime: {
                                    last24h: Number(service.uptime_24h || 100),
                                    last7d: Number(computeUptimeFromTotals(windows.last7d.total, windows.last7d.up).toFixed(4)),
                                    last30d: Number(computeUptimeFromTotals(windows.last30d.total, windows.last30d.up).toFixed(4)),
                                    last365d: Number(computeUptimeFromTotals(windows.last365d.total, windows.last365d.up).toFixed(4)),
                                    total: Number(computeUptimeFromTotals(windows.total.total, windows.total.up).toFixed(4))
                                },
                                incident: {
                                    activeSince: service.active_incident_since,
                                    lastStarted: service.last_incident_started,
                                    lastEnded: service.last_incident_ended,
                                    lastReason: service.last_incident_reason
                                },
                                degradation: {
                                    isDegraded: Boolean(service.is_degraded),
                                    activeSince: service.active_degradation_since,
                                    lastStarted: service.last_degradation_started,
                                    lastEnded: service.last_degradation_ended,
                                    lastReason: service.last_degradation_reason
                                },
                                telemetry: {
                                    recentEvents: eventsRows,
                                    latestRegionalSnapshot: regionalRows || [],
                                    rollupDaysTracked: rows.length,
                                    totalChecksTracked: windows.total.total
                                }
                            };

                            res.json(payload);
                        };

                        if (!regionalSql) {
                            onRegionalRows([]);
                            return;
                        }

                        db.all(regionalSql, [serviceId, latestTimestamp], (regionalErr, regionalRows) => {
                            if (regionalErr) return res.status(500).json({ error: 'Error fetching regional snapshot data.' });
                            onRegionalRows(regionalRows);
                        });
                    });
                });
            });
        });
    });
});

router.get('/:id/regions/latest', (req, res) => {
    const serviceId = req.params.id;
    db.get('SELECT user_id FROM services WHERE id = ?', [serviceId], (serviceErr, service) => {
        if (serviceErr || !service || service.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Service not found or not authorized.' });
        }

        const latestTimestampSql = `
            SELECT timestamp
            FROM status_history_regions
            WHERE service_id = ?
            ORDER BY timestamp DESC
            LIMIT 1`;
        db.get(latestTimestampSql, [serviceId], (timestampErr, timestampRow) => {
            if (timestampErr) return res.status(500).json({ error: 'Error fetching regional snapshot.' });
            if (!timestampRow?.timestamp) return res.json({ timestamp: null, regions: [] });

            const regionsSql = `
                SELECT timestamp, location_label, location_code, status, response_time, check_source, reason
                FROM status_history_regions
                WHERE service_id = ? AND timestamp = ?
                ORDER BY location_label ASC`;
            db.all(regionsSql, [serviceId, timestampRow.timestamp], (regionsErr, rows) => {
                if (regionsErr) return res.status(500).json({ error: 'Error fetching regional snapshot.' });
                res.json({
                    timestamp: timestampRow.timestamp,
                    regions: rows
                });
            });
        });
    });
});

router.get('/:id/incidents', (req, res) => {
    const serviceId = req.params.id;
    const limit = clampInteger(req.query.limit, 25, 1, 200);
    const offset = clampInteger(req.query.offset, 0, 0, 100000);

    db.get('SELECT user_id FROM services WHERE id = ?', [serviceId], (serviceErr, service) => {
        if (serviceErr || !service || service.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Service not found or not authorized.' });
        }

        db.get('SELECT COUNT(*) AS total FROM service_incidents WHERE service_id = ?', [serviceId], (countErr, countRow) => {
            if (countErr) return res.status(500).json({ error: 'Error fetching incidents.' });

            const incidentsSql = `
                SELECT id, started_at, ended_at, duration_ms, reason, resolved_by, start_check_source, end_check_source
                FROM service_incidents
                WHERE service_id = ?
                ORDER BY started_at DESC
                LIMIT ? OFFSET ?`;
            db.all(incidentsSql, [serviceId, limit, offset], (incidentErr, rows) => {
                if (incidentErr) return res.status(500).json({ error: 'Error fetching incidents.' });

                res.json({
                    total: countRow?.total || 0,
                    limit,
                    offset,
                    incidents: rows
                });
            });
        });
    });
});

router.get('/:id', (req, res) => {
    db.get('SELECT * FROM services WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], (err, row) => {
        if (err) return res.status(500).json({ error: 'Error fetching service.' });
        if (!row) return res.status(404).json({ error: 'Service not found.' });
        res.json(row);
    });
});

// ADDED BACK: The missing endpoint to get history for a service's graph
router.get('/:id/history', (req, res) => {
    // First, verify the user owns this service to prevent data leaks
    const serviceCheckSql = 'SELECT user_id FROM services WHERE id = ?';
    db.get(serviceCheckSql, [req.params.id], (err, service) => {
        if (err || !service || service.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Service not found or not authorized.' });
        }
        
        // If authorized, get the last 30 history records
        const historySql = `
            SELECT id, service_id, timestamp, status, response_time, check_source, is_degraded, check_reason, timed_out
            FROM status_history 
            WHERE service_id = ? 
            ORDER BY timestamp DESC 
            LIMIT 30`;
        db.all(historySql, [req.params.id], (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Error fetching service history.' });
            }
            // Reverse the array so the chart shows the oldest data on the left
            res.json(rows.reverse());
        });
    });
});

router.get('/:id/events', (req, res) => {
    const serviceCheckSql = 'SELECT user_id FROM services WHERE id = ?';
    db.get(serviceCheckSql, [req.params.id], (err, service) => {
        if (err || !service || service.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Service not found or not authorized.' });
        }

        const eventsSql = `
            SELECT timestamp, status, response_time, check_source, is_degraded, check_reason, timed_out
            FROM status_history
            WHERE service_id = ?
            ORDER BY timestamp DESC
            LIMIT 60`;
        db.all(eventsSql, [req.params.id], (eventsErr, rows) => {
            if (eventsErr) return res.status(500).json({ error: 'Error fetching service events.' });
            res.json(rows);
        });
    });
});

router.get('/:id/rollups', (req, res) => {
    const serviceCheckSql = 'SELECT user_id FROM services WHERE id = ?';
    db.get(serviceCheckSql, [req.params.id], (err, service) => {
        if (err || !service || service.user_id !== req.user.id) {
            return res.status(404).json({ error: 'Service not found or not authorized.' });
        }

        const rollupsSql = `
            SELECT date, checks_total, checks_up, checks_down, checks_degraded, avg_response_time, max_response_time
            FROM daily_rollups
            WHERE service_id = ?
            ORDER BY date DESC
            LIMIT 1825`;

        db.all(rollupsSql, [req.params.id], (rollupErr, rows) => {
            if (rollupErr) return res.status(500).json({ error: 'Error fetching service rollups.' });

            const totals = rows.reduce((accumulator, row) => {
                accumulator.totalChecks += row.checks_total;
                accumulator.upChecks += row.checks_up;
                accumulator.downChecks += row.checks_down;
                accumulator.degradedChecks += row.checks_degraded;
                accumulator.maxResponseTime = Math.max(accumulator.maxResponseTime, row.max_response_time || 0);
                return accumulator;
            }, { totalChecks: 0, upChecks: 0, downChecks: 0, degradedChecks: 0, maxResponseTime: 0 });

            const totalUptime = totals.totalChecks > 0 ? ((totals.upChecks / totals.totalChecks) * 100) : 100;

            res.json({
                days: rows,
                totals: {
                    ...totals,
                    uptime: Number(totalUptime.toFixed(4))
                }
            });
        });
    });
});


router.post('/', (req, res) => {
    const validation = validateServicePayload(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });

    const { name, type, target, interval, locations, alerts_enabled } = validation.value;
    const locationsJson = JSON.stringify(locations);
    const sql = 'INSERT INTO services (user_id, name, type, target, interval, locations, alerts_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)';
    db.run(sql, [req.user.id, name, type, target, interval, locationsJson, alerts_enabled], function(err) {
        if (err) return res.status(500).json({ error: 'Error adding service.' });
        db.get('SELECT * FROM services WHERE id = ? AND user_id = ?', [this.lastID, req.user.id], (readErr, service) => {
            if (!readErr && service) {
                scheduleNextCheck(service);
            }
            res.status(201).json({ id: this.lastID });
        });
    });
});

router.put('/:id', (req, res) => {
    const validation = validateServicePayload(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });

    const { name, type, target, interval, locations, alerts_enabled } = validation.value;
    const locationsJson = JSON.stringify(locations);
    const sql = `UPDATE services SET name = ?, type = ?, target = ?, interval = ?, locations = ?, alerts_enabled = ? WHERE id = ? AND user_id = ?`;
    db.run(sql, [name, type, target, interval, locationsJson, alerts_enabled, req.params.id, req.user.id], function(err) {
        if (err) return res.status(500).json({ error: 'Error updating service.' });
        if (this.changes === 0) return res.status(404).json({ error: 'Service not found or user not authorized.' });
        db.get('SELECT * FROM services WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], (readErr, service) => {
            if (!readErr && service) {
                scheduleNextCheck(service);
            }
            res.status(200).json({ message: 'Service updated successfully.' });
        });
    });
});

router.delete('/:id', (req, res) => {
    const sql = 'DELETE FROM services WHERE id = ? AND user_id = ?';
    db.run(sql, [req.params.id, req.user.id], function(err) {
        if (err) return res.status(500).json({ error: 'Error deleting service.' });
        if (this.changes === 0) return res.status(404).json({ error: 'Service not found or user not authorized.' });
        cancelCheck(req.params.id);
        res.sendStatus(204);
    });
});

module.exports = router;
