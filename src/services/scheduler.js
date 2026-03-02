// src/services/scheduler.js

const { db } = require('../config/database');
const dns = require('dns').promises;
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const GLOBALPING_API_KEY = process.env.GLOBALPING_API_KEY;
const ENABLE_LOCAL_FALLBACK = (process.env.ENABLE_LOCAL_FALLBACK || 'true').toLowerCase() === 'true';
const FORCE_LOCAL_ONLY_MODE = (process.env.FORCE_LOCAL_ONLY_MODE || 'false').toLowerCase() === 'true';
const GLOBALPING_FAILOVER_THRESHOLD = Number(process.env.GLOBALPING_FAILOVER_THRESHOLD || 3);
const GLOBALPING_RECOVERY_SUCCESS_THRESHOLD = Number(process.env.GLOBALPING_RECOVERY_SUCCESS_THRESHOLD || 2);
const GLOBALPING_RECOVERY_PROBE_INTERVAL_MS = Number(process.env.GLOBALPING_RECOVERY_PROBE_INTERVAL_MS || 120000);

const activeTimers = {};
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

function parseLocations(rawLocations) {
    try {
        const locations = JSON.parse(rawLocations || '[]');
        return Array.isArray(locations) ? locations : [];
    } catch {
        return [];
    }
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

async function fetchGlobalpingResults(fetchFn, id, headers) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await sleep(1500);
        const response = await fetchFn(`https://api.globalping.io/v1/measurements/${id}`, { headers });
        if (!response.ok) continue;
        const payload = await response.json();
        const results = extractProbeResults(payload);
        if (results.length > 0) {
            return { payload, results };
        }
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
            globalpingOperational: false
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
            globalpingOperational: false
        };
    }

    let body = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }

    let probeResults = extractProbeResults(body);
    if (probeResults.length === 0 && body && body.id) {
        const fetched = await fetchGlobalpingResults(fetchFn, body.id, headers);
        probeResults = fetched.results;
    }

    if (probeResults.length === 0) {
        return {
            source: 'globalping',
            isUp: true,
            responseTime,
            reason: 'Globalping accepted request but no probe payload was available',
            globalpingOperational: true
        };
    }

    const evaluations = probeResults.map(result => evaluateProbeResult(result, service.type));
    const successCount = evaluations.filter(item => item.success).length;
    const failureCount = evaluations.length - successCount;
    const isUp = successCount > 0;

    const parsedTimes = probeResults.map(getResultResponseTime).filter(value => typeof value === 'number');
    const averageResponseTime = parsedTimes.length > 0
        ? Math.round(parsedTimes.reduce((total, value) => total + value, 0) / parsedTimes.length)
        : responseTime;

    const reason = isUp
        ? `Globalping probes succeeded: ${successCount}/${evaluations.length}`
        : evaluations.map(item => item.reason).slice(0, 2).join('; ') || `Globalping probes failed: ${failureCount}/${evaluations.length}`;

    return {
        source: 'globalping',
        isUp,
        responseTime: averageResponseTime,
        reason,
        globalpingOperational: true
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
                reason: response.ok ? `Local HTTP ${response.status}` : `Local HTTP ${response.status}`
            };
        }

        if (service.type === 'dns') {
            const records = await dns.resolve(service.target);
            const duration = Date.now() - startTime;
            return {
                source: 'local',
                isUp: Array.isArray(records) && records.length > 0,
                responseTime: duration,
                reason: Array.isArray(records) && records.length > 0 ? 'Local DNS resolved' : 'Local DNS returned no records'
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
            reason: 'Local ping succeeded'
        };
    } catch (error) {
        return {
            source: 'local',
            isUp: false,
            responseTime: Date.now() - startTime,
            reason: `Local check failed: ${error.message || 'unknown error'}`
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

async function persistCheckResult(service, result) {
    const nowIso = new Date().toISOString();
    const statusText = result.isUp ? 'Up' : 'Down';
    const responseTime = typeof result.responseTime === 'number' ? result.responseTime : 0;

    await runAsync(
        'INSERT INTO status_history (service_id, timestamp, status, response_time) VALUES (?, ?, ?, ?)',
        [service.id, nowIso, result.isUp ? 1 : 0, responseTime]
    );

    const uptimePercentage = await calculateUptime(service.id, nowIso);
    const existing = await getAsync('SELECT status, active_incident_since FROM services WHERE id = ?', [service.id]);

    let activeIncidentSince = existing?.active_incident_since || null;
    let lastIncidentStarted = existing?.last_incident_started || null;
    let lastIncidentEnded = existing?.last_incident_ended || null;
    let lastIncidentReason = existing?.last_incident_reason || null;

    if (statusText === 'Down' && existing?.status !== 'Down') {
        activeIncidentSince = nowIso;
        lastIncidentStarted = nowIso;
        lastIncidentReason = result.reason || 'Health check failed';
    }

    if (statusText === 'Up' && existing?.status === 'Down') {
        lastIncidentEnded = nowIso;
        activeIncidentSince = null;
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
             last_check_source = ?
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
            service.id
        ]
    );

    console.log(
        ` -> [RESULT] ${service.name}: ${statusText} (${responseTime}ms) source=${result.source} uptime24h=${uptimePercentage.toFixed(2)}%`
    );

    if (result.reason) {
        console.log(` -> [DETAIL] ${service.name}: ${result.reason}`);
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
    if (activeTimers[service.id]) clearTimeout(activeTimers[service.id]);
    const lastChecked = service.lastChecked ? new Date(service.lastChecked).getTime() : 0;
    const delay = Math.max(0, (lastChecked + service.interval) - Date.now());
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
    console.log(` -> [RUNNING] Checking ${service.name} (${service.target})`);
    const locations = parseLocations(service.locations);
    const globalLocations = locations.filter(location => location.type !== 'local');

    let checkResult = null;
    let globalAttempted = false;

    const allowGlobal = !FORCE_LOCAL_ONLY_MODE
        && globalLocations.length > 0
        && (!globalpingState.failoverActive || shouldProbeGlobalpingInFailover());

    if (allowGlobal) {
        globalAttempted = true;
        checkResult = await runGlobalpingCheck(service, globalLocations);
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
        const localResult = await runLocalCheck(service);
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

    const checkedAtIso = await persistCheckResult(service, checkResult);
    scheduleNextCheck({ ...service, lastChecked: checkedAtIso });
}

module.exports = {
    initializeAllSchedules,
    scheduleNextCheck,
    cancelCheck,
    getMonitoringStatus
};
