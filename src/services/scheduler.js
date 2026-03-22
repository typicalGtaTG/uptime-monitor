// src/services/scheduler.js

const { db } = require('../config/database');
const dns = require('dns').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const { dispatchAlerts } = require('./alerts');

const execAsync = promisify(exec);
const GLOBALPING_API_KEY = process.env.GLOBALPING_API_KEY;
const ENABLE_LOCAL_FALLBACK = (process.env.ENABLE_LOCAL_FALLBACK || 'true').toLowerCase() === 'true';
const FORCE_LOCAL_ONLY_MODE = (process.env.FORCE_LOCAL_ONLY_MODE || 'false').toLowerCase() === 'true';
const GLOBALPING_FAILOVER_THRESHOLD = Number(process.env.GLOBALPING_FAILOVER_THRESHOLD || 3);
const GLOBALPING_RECOVERY_SUCCESS_THRESHOLD = Number(process.env.GLOBALPING_RECOVERY_SUCCESS_THRESHOLD || 2);
const GLOBALPING_RECOVERY_PROBE_INTERVAL_MS = Number(process.env.GLOBALPING_RECOVERY_PROBE_INTERVAL_MS || 120000);
const DEGRADATION_RESPONSE_TIME_MS = Number(process.env.DEGRADATION_RESPONSE_TIME_MS || 1200);
const RAW_HISTORY_RETENTION_DAYS = Number(process.env.RAW_HISTORY_RETENTION_DAYS || 120);
const REGIONAL_HISTORY_RETENTION_DAYS = Number(process.env.REGIONAL_HISTORY_RETENTION_DAYS || 30);

const activeTimers = {};
const activeChecks = new Set();
const globalpingState = {
    failoverActive: false,
    consecutiveFailures: 0,
    consecutiveRecoverySuccesses: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastRecoveryProbeAt: 0
};

function runAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function getAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function allAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getServiceById(serviceId) {
    return getAsync('SELECT * FROM services WHERE id = ?', [serviceId]);
}

function parseLocations(rawLocations) {
    try {
        const locations = JSON.parse(rawLocations || '[]');
        return Array.isArray(locations) ? locations : [];
    } catch {
        return [];
    }
}

function deriveCheckQuality(result) {
    const timedOut = Boolean(result?.timedOut) || /timeout|timed out/i.test(String(result?.reason || ''));
    const degraded = Boolean(result?.degraded);
    return { timedOut, degraded };
}

function sanitizeLocationCode(value) {
    if (!value) return null;
    const code = String(value).trim().toUpperCase();
    return code.length > 12 ? code.slice(0, 12) : code;
}

function resolveProbeLocation(result, fallbackLocation, index) {
    const probe = result?.probe || result?.location || result?.resolver || {};
    const city = result?.city || probe?.city || probe?.cityName || probe?.name || null;
    const countryCode = sanitizeLocationCode(
        result?.countryCode || result?.country_code || probe?.countryCode || probe?.country_code || probe?.country
    ) || sanitizeLocationCode(fallbackLocation?.value);

    const label = city && countryCode
        ? `${city} (${countryCode})`
        : city
            ? city
            : countryCode
                ? countryCode
                : `Probe ${index + 1}`;

    return {
        code: countryCode,
        label
    };
}

function getMonitoringStatus() {
    const mode = FORCE_LOCAL_ONLY_MODE
        ? 'local-only'
        : globalpingState.failoverActive
            ? 'failover'
            : 'global';

    const warning = mode !== 'global';
    const message = mode === 'local-only'
        ? 'Local-only mode is enabled via environment. Globalping checks are paused.'
        : mode === 'failover'
            ? 'Globalping requests are failing. Checks are temporarily running in local failover mode.'
            : null;

    return {
        mode,
        warning,
        message,
        enableLocalFallback: ENABLE_LOCAL_FALLBACK,
        forceLocalOnlyMode: FORCE_LOCAL_ONLY_MODE,
        failoverActive: globalpingState.failoverActive,
        consecutiveFailures: globalpingState.consecutiveFailures,
        lastFailureAt: globalpingState.lastFailureAt,
        lastSuccessAt: globalpingState.lastSuccessAt,
        lastError: globalpingState.lastError
    };
}

function markGlobalpingFailure(errorText) {
    if (!ENABLE_LOCAL_FALLBACK || FORCE_LOCAL_ONLY_MODE) return;
    globalpingState.consecutiveFailures += 1;
    globalpingState.consecutiveRecoverySuccesses = 0;
    globalpingState.lastFailureAt = new Date().toISOString();
    globalpingState.lastError = errorText || 'Globalping request failed';

    if (!globalpingState.failoverActive && globalpingState.consecutiveFailures >= GLOBALPING_FAILOVER_THRESHOLD) {
        globalpingState.failoverActive = true;
        console.warn('Scheduler: Entered Globalping failover mode. Local checks are now active.');
    }
}

function markGlobalpingSuccess() {
    globalpingState.lastSuccessAt = new Date().toISOString();
    globalpingState.lastError = null;
    if (globalpingState.failoverActive) {
        globalpingState.consecutiveRecoverySuccesses += 1;
        if (globalpingState.consecutiveRecoverySuccesses >= GLOBALPING_RECOVERY_SUCCESS_THRESHOLD) {
            globalpingState.failoverActive = false;
            globalpingState.consecutiveFailures = 0;
            globalpingState.consecutiveRecoverySuccesses = 0;
            console.log('Scheduler: Globalping recovered. Exiting failover mode.');
        }
        return;
    }

    globalpingState.consecutiveFailures = 0;
}

function shouldProbeGlobalpingInFailover() {
    if (!globalpingState.failoverActive) return true;
    const now = Date.now();
    if (now - globalpingState.lastRecoveryProbeAt >= GLOBALPING_RECOVERY_PROBE_INTERVAL_MS) {
        globalpingState.lastRecoveryProbeAt = now;
        return true;
    }
    return false;
}

async function getFetch() {
    const fetchModule = await import('node-fetch');
    return fetchModule.default;
}

function normalizeHttpTarget(target) {
    const trimmed = String(target || '').trim();
    if (!trimmed) return trimmed;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    return `https://${trimmed}`;
}

function getResultResponseTime(result) {
    if (!result || typeof result !== 'object') return null;
    const candidates = [
        result.responseTime,
        result.response_time,
        result.latency,
        result.time,
        result.duration,
        result.rtt,
        result?.timings?.total,
        result?.timings?.firstByte,
        result?.timings?.dns,
        result?.result?.responseTime,
        result?.result?.time,
        result?.result?.latency,
        result?.result?.rtt,
        result?.result?.timings?.total
    ];

    for (const value of candidates) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.max(0, Math.round(value));
        }
    }
    return null;
}

function evaluateProbeResult(result, type) {
    if (!result || typeof result !== 'object') {
        return { success: false, reason: 'No probe result returned' };
    }

    if (result.error || result.errorMessage || result.message === 'error') {
        return { success: false, reason: result.error || result.errorMessage || 'Probe error' };
    }

    // Probe result field is null when measurement is still in-progress — treat as failure
    if (result.result === null || result.result === undefined) {
        return { success: false, reason: 'No probe result data (measurement incomplete)' };
    }

    const statusText = String(result.status || result.state || result.result?.status || '').toLowerCase();
    if (statusText.includes('fail') || statusText.includes('error') || statusText.includes('timeout')) {
        return { success: false, reason: `Probe status: ${statusText}` };
    }

    const nested = result.result || result;
    if (type === 'http') {
        const statusCode = nested.statusCode || nested.status || nested.code;
        if (typeof statusCode === 'number') {
            const success = statusCode >= 200 && statusCode < 400;
            return { success, reason: success ? `HTTP ${statusCode}` : `HTTP ${statusCode}` };
        }
    }

    if (type === 'dns') {
        const answers = nested.answers || nested.answer;
        if (Array.isArray(answers)) {
            const success = answers.length > 0;
            return { success, reason: success ? 'DNS records returned' : 'No DNS answers' };
        }
    }

    if (type === 'ping') {
        if (typeof nested.alive === 'boolean') {
            return { success: nested.alive, reason: nested.alive ? 'Ping reachable' : 'Ping unreachable' };
        }
        if (typeof nested.packetLoss === 'number') {
            const success = nested.packetLoss < 100;
            return { success, reason: success ? 'Ping packets received' : '100% packet loss' };
        }
    }

    if (statusText.includes('ok') || statusText.includes('success') || statusText.includes('finished')) {
        return { success: true, reason: `Probe status: ${statusText}` };
    }

    return { success: true, reason: 'Probe completed' };
}

function extractProbeResults(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;

    const candidates = [
        payload.results,
        payload.measurements,
        payload.probes,
        payload.data
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate;
    }

    return [];
}

async function fetchGlobalpingResults(fetchFn, id, headers, maxWaitMs = 35000) {
    const deadline = Date.now() + maxWaitMs;
    let delay = 1500;
    // First poll after a short initial delay
    await sleep(1000);
    while (Date.now() < deadline) {
        const response = await fetchFn(`https://api.globalping.io/v1/measurements/${id}`, { headers });
        if (response.ok) {
            const payload = await response.json();
            // Only use results once the measurement is fully finished
            if (payload.status === 'finished') {
                const results = extractProbeResults(payload);
                return { payload, results };
            }
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(delay, remaining));
        delay = Math.min(Math.round(delay * 1.5), 4000);
    }
    return { payload: null, results: [] };
}

async function runGlobalpingCheck(service, globalLocations) {
    const fetchFn = await getFetch();
    const headers = { 'Content-Type': 'application/json' };
    if (GLOBALPING_API_KEY) headers.Authorization = `Bearer ${GLOBALPING_API_KEY}`;

    const payload = {
        type: service.type,
        target: service.target,
        locations: globalLocations.map(loc => ({ [loc.type]: loc.value, limit: 1 }))
    };

    const startTime = Date.now();
    let response;
    try {
        response = await fetchFn('https://api.globalping.io/v1/measurements', {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
    } catch (error) {
        return {
            source: 'globalping',
            isUp: false,
            responseTime: Date.now() - startTime,
            reason: `Globalping network error: ${error.message || 'unknown error'}`,
            globalpingOperational: false,
            timedOut: /timeout|timed out/i.test(String(error?.message || '')),
            regional: []
        };
    }

    const responseTime = Date.now() - startTime;
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
            source: 'globalping',
            isUp: false,
            responseTime,
            reason: `Globalping HTTP ${response.status}${text ? ` - ${text.slice(0, 140)}` : ''}`,
            globalpingOperational: false,
            timedOut: false,
            regional: []
        };
    }

    let body = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }

    // Always poll for the finished measurement — the initial POST body contains
    // in-progress probes (result: null) which must not be used for evaluation.
    let probeResults = [];
    if (body && body.id) {
        const fetched = await fetchGlobalpingResults(fetchFn, body.id, headers);
        probeResults = fetched.results;
    } else {
        probeResults = extractProbeResults(body);
    }

    if (probeResults.length === 0) {
        return {
            source: 'globalping',
            isUp: true,
            responseTime,
            reason: 'Globalping accepted request but no probe payload was available',
            globalpingOperational: true,
            degraded: false,
            timedOut: false,
            regional: []
        };
    }

    const evaluations = probeResults.map((result, index) => {
        const evaluation = evaluateProbeResult(result, service.type);
        const location = resolveProbeLocation(result, globalLocations[index], index);
        const probeResponseTime = getResultResponseTime(result);
        return {
            ...evaluation,
            locationCode: location.code,
            locationLabel: location.label,
            responseTime: typeof probeResponseTime === 'number' ? probeResponseTime : responseTime
        };
    });

    const successCount = evaluations.filter(item => item.success).length;
    const failureCount = evaluations.length - successCount;
    const isUp = successCount > 0;
    const partialFailure = isUp && failureCount > 0;

    const parsedTimes = evaluations.map(item => item.responseTime).filter(value => typeof value === 'number');
    const averageResponseTime = parsedTimes.length > 0
        ? Math.round(parsedTimes.reduce((total, value) => total + value, 0) / parsedTimes.length)
        : responseTime;

    const latencyDegraded = averageResponseTime > DEGRADATION_RESPONSE_TIME_MS;
    const degraded = partialFailure || latencyDegraded;

    const reason = isUp
        ? `Globalping probes succeeded: ${successCount}/${evaluations.length}`
        : evaluations.map(item => item.reason).slice(0, 2).join('; ') || `Globalping probes failed: ${failureCount}/${evaluations.length}`;

    const reasonWithDegradedContext = degraded && isUp
        ? `${reason}${latencyDegraded ? `; high latency ${averageResponseTime}ms` : '; partial probe failures'}`
        : reason;

    const timedOut = evaluations.some(item => /timeout|timed out/i.test(String(item.reason || '')));
    const regional = evaluations.map(item => ({
        locationLabel: item.locationLabel,
        locationCode: item.locationCode,
        status: item.success ? 1 : 0,
        responseTime: typeof item.responseTime === 'number' ? item.responseTime : averageResponseTime,
        reason: item.reason || null
    }));

    return {
        source: 'globalping',
        isUp,
        responseTime: averageResponseTime,
        reason: reasonWithDegradedContext,
        globalpingOperational: true,
        degraded,
        timedOut,
        regional
    };
}

async function runLocalCheck(service) {
    const startTime = Date.now();
    try {
        if (service.type === 'http') {
            const fetchFn = await getFetch();
            const response = await fetchFn(normalizeHttpTarget(service.target), { method: 'GET' });
            const duration = Date.now() - startTime;
            return {
                source: 'local',
                isUp: response.ok,
                responseTime: duration,
                reason: response.ok ? `Local HTTP ${response.status}` : `Local HTTP ${response.status}`,
                degraded: response.ok && duration > DEGRADATION_RESPONSE_TIME_MS,
                timedOut: false,
                regional: [{
                    locationLabel: 'Local (This Server)',
                    locationCode: 'LOCAL',
                    status: response.ok ? 1 : 0,
                    responseTime: duration,
                    reason: response.ok ? `Local HTTP ${response.status}` : `Local HTTP ${response.status}`
                }]
            };
        }

        if (service.type === 'dns') {
            const records = await dns.resolve(service.target);
            const duration = Date.now() - startTime;
            return {
                source: 'local',
                isUp: Array.isArray(records) && records.length > 0,
                responseTime: duration,
                reason: Array.isArray(records) && records.length > 0 ? 'Local DNS resolved' : 'Local DNS returned no records',
                degraded: Array.isArray(records) && records.length > 0 && duration > DEGRADATION_RESPONSE_TIME_MS,
                timedOut: false,
                regional: [{
                    locationLabel: 'Local (This Server)',
                    locationCode: 'LOCAL',
                    status: Array.isArray(records) && records.length > 0 ? 1 : 0,
                    responseTime: duration,
                    reason: Array.isArray(records) && records.length > 0 ? 'Local DNS resolved' : 'Local DNS returned no records'
                }]
            };
        }

        const pingCommand = process.platform === 'win32'
            ? `ping -n 1 -w 3000 "${service.target}"`
            : `ping -c 1 -W 3 "${service.target}"`;
        await execAsync(pingCommand);
        const duration = Date.now() - startTime;
        return {
            source: 'local',
            isUp: true,
            responseTime: duration,
            reason: 'Local ping succeeded',
            degraded: duration > DEGRADATION_RESPONSE_TIME_MS,
            timedOut: false,
            regional: [{
                locationLabel: 'Local (This Server)',
                locationCode: 'LOCAL',
                status: 1,
                responseTime: duration,
                reason: 'Local ping succeeded'
            }]
        };
    } catch (error) {
        const failureReason = `Local check failed: ${error.message || 'unknown error'}`;
        return {
            source: 'local',
            isUp: false,
            responseTime: Date.now() - startTime,
            reason: failureReason,
            degraded: false,
            timedOut: /timeout|timed out/i.test(String(error?.message || '')),
            regional: [{
                locationLabel: 'Local (This Server)',
                locationCode: 'LOCAL',
                status: 0,
                responseTime: Date.now() - startTime,
                reason: failureReason
            }]
        };
    }
}

async function calculateUptime(serviceId, nowIso) {
    const twentyFourHoursAgo = new Date(new Date(nowIso).getTime() - (24 * 60 * 60 * 1000)).toISOString();
    const rows = await allAsync(
        'SELECT status FROM status_history WHERE service_id = ? AND timestamp >= ?',
        [serviceId, twentyFourHoursAgo]
    );
    const upCount = rows.filter(item => item.status === 1).length;
    const totalCount = rows.length;
    return totalCount > 0 ? (upCount / totalCount) * 100 : 100;
}

async function upsertDailyRollup(serviceId, nowIso, isUp, degraded, responseTime) {
    const day = nowIso.slice(0, 10);
    const existing = await getAsync(
        'SELECT checks_total, checks_up, checks_down, checks_degraded, avg_response_time, max_response_time FROM daily_rollups WHERE service_id = ? AND date = ?',
        [serviceId, day]
    );

    if (!existing) {
        await runAsync(
            `INSERT INTO daily_rollups
            (service_id, date, checks_total, checks_up, checks_down, checks_degraded, avg_response_time, max_response_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                serviceId,
                day,
                1,
                isUp ? 1 : 0,
                isUp ? 0 : 1,
                degraded ? 1 : 0,
                responseTime,
                responseTime
            ]
        );
        return;
    }

    const nextChecksTotal = existing.checks_total + 1;
    const nextChecksUp = existing.checks_up + (isUp ? 1 : 0);
    const nextChecksDown = existing.checks_down + (isUp ? 0 : 1);
    const nextChecksDegraded = existing.checks_degraded + (degraded ? 1 : 0);
    const nextAvg = ((existing.avg_response_time * existing.checks_total) + responseTime) / nextChecksTotal;
    const nextMax = Math.max(existing.max_response_time || 0, responseTime);

    await runAsync(
        `UPDATE daily_rollups
         SET checks_total = ?,
             checks_up = ?,
             checks_down = ?,
             checks_degraded = ?,
             avg_response_time = ?,
             max_response_time = ?
         WHERE service_id = ? AND date = ?`,
        [
            nextChecksTotal,
            nextChecksUp,
            nextChecksDown,
            nextChecksDegraded,
            nextAvg,
            nextMax,
            serviceId,
            day
        ]
    );
}

async function pruneRawHistory(serviceId, nowIso) {
    const cutoff = new Date(new Date(nowIso).getTime() - (RAW_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000)).toISOString();
    await runAsync('DELETE FROM status_history WHERE service_id = ? AND timestamp < ?', [serviceId, cutoff]);
}

async function pruneRegionalHistory(serviceId, nowIso) {
    const cutoff = new Date(new Date(nowIso).getTime() - (REGIONAL_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000)).toISOString();
    await runAsync('DELETE FROM status_history_regions WHERE service_id = ? AND timestamp < ?', [serviceId, cutoff]);
}

async function persistCheckResult(service, result) {
    const nowIso = new Date().toISOString();
    const statusText = result.isUp ? 'Up' : 'Down';
    const responseTime = typeof result.responseTime === 'number' ? result.responseTime : 0;
    const { timedOut, degraded } = deriveCheckQuality(result);

    const historyInsert = await runAsync(
        `INSERT INTO status_history
            (service_id, timestamp, status, response_time, check_source, is_degraded, check_reason, timed_out)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [service.id, nowIso, result.isUp ? 1 : 0, responseTime, result.source, degraded ? 1 : 0, result.reason || null, timedOut ? 1 : 0]
    );

    const historyId = historyInsert?.lastID;
    const regionalRows = Array.isArray(result.regional) && result.regional.length > 0
        ? result.regional
        : [{
            locationLabel: result.source === 'local' ? 'Local (This Server)' : 'Unknown',
            locationCode: result.source === 'local' ? 'LOCAL' : null,
            status: result.isUp ? 1 : 0,
            responseTime,
            reason: result.reason || null
        }];

    if (historyId) {
        for (const row of regionalRows) {
            await runAsync(
                `INSERT INTO status_history_regions
                    (service_id, history_id, timestamp, location_label, location_code, status, response_time, check_source, reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    service.id,
                    historyId,
                    nowIso,
                    row.locationLabel || 'Unknown',
                    sanitizeLocationCode(row.locationCode),
                    row.status === 1 ? 1 : 0,
                    typeof row.responseTime === 'number' ? row.responseTime : responseTime,
                    result.source || 'unknown',
                    row.reason || null
                ]
            );
        }
    }

    await upsertDailyRollup(service.id, nowIso, result.isUp, degraded, responseTime);
    await pruneRawHistory(service.id, nowIso);
    await pruneRegionalHistory(service.id, nowIso);

    const uptimePercentage = await calculateUptime(service.id, nowIso);
    const existing = await getAsync(
        `SELECT status, active_incident_since, last_incident_started, last_incident_ended, last_incident_reason,
            is_degraded, active_degradation_since,
                last_degradation_started, last_degradation_ended, last_degradation_reason
         FROM services WHERE id = ?`,
        [service.id]
    );

    let activeIncidentSince = existing?.active_incident_since || null;
    let lastIncidentStarted = existing?.last_incident_started || null;
    let lastIncidentEnded = existing?.last_incident_ended || null;
    let lastIncidentReason = existing?.last_incident_reason || null;

    let isDegraded = degraded && statusText === 'Up';
    let activeDegradationSince = existing?.active_degradation_since || null;
    let lastDegradationStarted = existing?.last_degradation_started || null;
    let lastDegradationEnded = existing?.last_degradation_ended || null;
    let lastDegradationReason = existing?.last_degradation_reason || null;

    if (statusText === 'Down' && existing?.status !== 'Down') {
        activeIncidentSince = nowIso;
        lastIncidentStarted = nowIso;
        lastIncidentReason = result.reason || 'Health check failed';

        await runAsync(
            `INSERT INTO service_incidents
                (service_id, started_at, reason, start_check_source)
             VALUES (?, ?, ?, ?)`,
            [service.id, nowIso, lastIncidentReason, result.source || 'unknown']
        );
    }

    if (statusText === 'Up' && existing?.status === 'Down') {
        lastIncidentEnded = nowIso;
        activeIncidentSince = null;

        const openIncident = await getAsync(
            `SELECT id, started_at
             FROM service_incidents
             WHERE service_id = ? AND ended_at IS NULL
             ORDER BY started_at DESC
             LIMIT 1`,
            [service.id]
        );

        if (openIncident) {
            const durationMs = Math.max(0, new Date(nowIso).getTime() - new Date(openIncident.started_at).getTime());
            await runAsync(
                `UPDATE service_incidents
                 SET ended_at = ?, duration_ms = ?, resolved_by = ?, end_check_source = ?
                 WHERE id = ?`,
                [nowIso, durationMs, result.reason || 'Recovered', result.source || 'unknown', openIncident.id]
            );
        }
    }

    if (isDegraded && !existing?.is_degraded) {
        activeDegradationSince = nowIso;
        lastDegradationStarted = nowIso;
        lastDegradationReason = result.reason || 'Response quality degraded';
    }

    if (!isDegraded && existing?.is_degraded) {
        activeDegradationSince = null;
        lastDegradationEnded = nowIso;
    }

    if (statusText === 'Down' && existing?.is_degraded) {
        isDegraded = false;
        activeDegradationSince = null;
        lastDegradationEnded = nowIso;
    }

    await runAsync(
        `UPDATE services
         SET status = ?,
             lastChecked = ?,
             lastResponseTime = ?,
             uptime_24h = ?,
             active_incident_since = ?,
             last_incident_started = ?,
             last_incident_ended = ?,
             last_incident_reason = ?,
             last_check_source = ?,
             is_degraded = ?,
             active_degradation_since = ?,
             last_degradation_started = ?,
             last_degradation_ended = ?,
             last_degradation_reason = ?,
             last_check_reason = ?
         WHERE id = ?`,
        [
            statusText,
            nowIso,
            responseTime,
            uptimePercentage.toFixed(2),
            activeIncidentSince,
            lastIncidentStarted,
            lastIncidentEnded,
            lastIncidentReason,
            result.source,
            isDegraded ? 1 : 0,
            activeDegradationSince,
            lastDegradationStarted,
            lastDegradationEnded,
            lastDegradationReason,
            result.reason || null,
            service.id
        ]
    );

    console.log(
        ` -> [RESULT] ${service.name}: ${statusText} (${responseTime}ms) source=${result.source} uptime24h=${uptimePercentage.toFixed(2)}%`
    );

    if (result.reason) {
        console.log(` -> [DETAIL] ${service.name}: ${result.reason}`);
    }

    // Dispatch webhook alerts for status transitions
    const updatedService = { ...service, status: statusText, alerts_enabled: service.alerts_enabled };
    const wasDown = existing?.status === 'Down';
    const isNowDown = statusText === 'Down';
    const isNowDegraded = isDegraded && statusText === 'Up';
    const wasNowDegraded = Boolean(existing?.is_degraded) && statusText === 'Up';

    if (isNowDown && !wasDown) {
        dispatchAlerts(updatedService, 'service.down', result.reason || 'Health check failed').catch(() => {});
    } else if (!isNowDown && wasDown) {
        dispatchAlerts(updatedService, 'service.recovered', result.reason || 'Service recovered').catch(() => {});
    } else if (isNowDegraded && !wasNowDegraded) {
        dispatchAlerts(updatedService, 'service.degraded', result.reason || 'Service degraded').catch(() => {});
    }

    return nowIso;
}

function initializeAllSchedules() {
    console.log('Initializing monitoring schedules...');
    db.all('SELECT * FROM services', [], (err, services) => {
        if (err) return console.error('Scheduler: Error fetching services.', err);
        services.forEach(scheduleNextCheck);
        console.log(`Initialized ${services.length} service monitors.`);
    });
}

function scheduleNextCheck(service) {
    if (process.env.TEST_MODE) return;
    if (activeTimers[service.id]) clearTimeout(activeTimers[service.id]);
    const lastChecked = service.lastChecked ? new Date(service.lastChecked).getTime() : 0;
    const intervalMs = Number(service.interval);
    const safeInterval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60000;
    const delay = Math.max(0, (lastChecked + safeInterval) - Date.now());
    console.log(` -> Scheduling check for "${service.name}" (ID: ${service.id}) in ${delay}ms`);
    activeTimers[service.id] = setTimeout(() => {
        performCheck(service).catch(error => {
            console.error(`Scheduler: Fatal check error for service ID ${service.id}`, error);
            const updatedService = { ...service, lastChecked: new Date().toISOString() };
            scheduleNextCheck(updatedService);
        });
    }, delay);
}

function cancelCheck(serviceId) {
    if (activeTimers[serviceId]) {
        clearTimeout(activeTimers[serviceId]);
        delete activeTimers[serviceId];
        console.log(` -> Canceled scheduled check for service ID: ${serviceId}`);
    }
}

async function performCheck(service) {
    if (!service?.id) return;
    if (activeChecks.has(service.id)) {
        console.warn(`Scheduler: Skipping overlap for service ID ${service.id} because a check is already running.`);
        return;
    }

    activeChecks.add(service.id);

    try {
        const freshService = await getServiceById(service.id);
        if (!freshService) {
            cancelCheck(service.id);
            return;
        }

        console.log(` -> [RUNNING] Checking ${freshService.name} (${freshService.target})`);
        const locations = parseLocations(freshService.locations);
        const globalLocations = locations.filter(location => location.type !== 'local');

        let checkResult = null;
        let globalAttempted = false;

        const allowGlobal = !FORCE_LOCAL_ONLY_MODE
            && globalLocations.length > 0
            && (!globalpingState.failoverActive || shouldProbeGlobalpingInFailover());

        if (allowGlobal) {
            globalAttempted = true;
            checkResult = await runGlobalpingCheck(freshService, globalLocations);
            if (checkResult.globalpingOperational) {
                markGlobalpingSuccess();
            } else {
                markGlobalpingFailure(checkResult.reason);
            }
        }

        const shouldUseLocal = FORCE_LOCAL_ONLY_MODE
            || (ENABLE_LOCAL_FALLBACK && globalpingState.failoverActive)
            || globalLocations.length === 0
            || (globalAttempted && checkResult && !checkResult.globalpingOperational);

        if (shouldUseLocal) {
            const localResult = await runLocalCheck(freshService);
            if (!checkResult || !checkResult.globalpingOperational) {
                checkResult = localResult;
            }
        }

        if (!checkResult) {
            checkResult = {
                source: 'local',
                isUp: false,
                responseTime: 0,
                reason: 'No check path was available'
            };
        }

        const checkedAtIso = await persistCheckResult(freshService, checkResult);
        const latestService = await getServiceById(freshService.id);
        if (!latestService) {
            cancelCheck(freshService.id);
            return;
        }

        scheduleNextCheck({ ...latestService, lastChecked: checkedAtIso });
    } finally {
        activeChecks.delete(service.id);
    }
}

module.exports = {
    initializeAllSchedules,
    scheduleNextCheck,
    cancelCheck,
    getMonitoringStatus
};
