const express = require('express');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const authenticateToken = require('../middleware/auth');

const router = express.Router();

const GLOBALPING_API_KEY = process.env.GLOBALPING_API_KEY;
const TOOLS_DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.TOOLS_DEFAULT_TIMEOUT_MS || 5000));
const TOOLS_MAX_TIMEOUT_MS = Math.max(TOOLS_DEFAULT_TIMEOUT_MS, Number(process.env.TOOLS_MAX_TIMEOUT_MS || 20000));
const TOOLS_TRACEROUTE_MAX_HOPS = Math.max(1, Number(process.env.TOOLS_TRACEROUTE_MAX_HOPS || 20));
const TOOLS_MTR_REPORT_CYCLES = Math.max(1, Number(process.env.TOOLS_MTR_REPORT_CYCLES || 5));
const TOOLS_MAX_PACKET_COUNT = Math.max(1, Number(process.env.TOOLS_MAX_PACKET_COUNT || 16));
const JOB_RETENTION_MS = 20 * 60 * 1000;

const ALLOWED_TOOLS = new Set(['ping', 'traceroute', 'dns', 'mtr', 'http']);
const ALLOWED_DNS_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV']);
const ALLOWED_HTTP_METHODS = new Set(['GET', 'HEAD']);

const toolJobs = new Map();

router.use(authenticateToken);

function clampTimeout(timeoutMs) {
    const parsed = Number(timeoutMs);
    if (!Number.isFinite(parsed)) return TOOLS_DEFAULT_TIMEOUT_MS;
    return Math.max(1000, Math.min(TOOLS_MAX_TIMEOUT_MS, Math.floor(parsed)));
}

function clampInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeTarget(value) {
    return String(value || '').trim();
}

function normalizeLocations(rawLocations) {
    if (!Array.isArray(rawLocations)) return [];

    return rawLocations
        .filter(location => location && typeof location === 'object')
        .map(location => ({
            value: String(location.value || '').trim().toUpperCase(),
            type: String(location.type || '').trim().toLowerCase()
        }))
        .filter(location => {
            if (!location.value) return false;
            if (location.type === 'local') return location.value === 'LOCAL';
            if (location.type === 'country') return /^[A-Z]{2}$/.test(location.value);
            return false;
        });
}

function sendValidationError(res, message) {
    return res.status(400).json({ error: message });
}

function markJobStopped(job, reason = 'Run stopped by user.') {
    if (!job) return;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'stopped') return;

    const nowIso = new Date().toISOString();
    job.status = 'stopped';
    job.error = reason;
    job.completedAt = nowIso;
    job.updatedAt = nowIso;
}

function isJobRunning(job) {
    return Boolean(job && (job.status === 'running' || job.status === 'stopping'));
}

function cleanupExpiredJobs() {
    const now = Date.now();
    for (const [jobId, job] of toolJobs.entries()) {
        const ageMs = now - new Date(job.updatedAt).getTime();

        if (isJobRunning(job) && ageMs > JOB_RETENTION_MS) {
            markJobStopped(job, 'Run auto-stopped after session timeout.');
            continue;
        }

        if (ageMs > JOB_RETENTION_MS) {
            toolJobs.delete(jobId);
        }
    }
}

function getFetchImpl() {
    if (typeof fetch === 'function') return Promise.resolve(fetch);
    return import('node-fetch').then(mod => mod.default);
}

function resolveProbeLocation(result, fallbackLocation, index) {
    const probe = result?.probe || result?.location || result?.resolver || {};
    const city = result?.city || probe?.city || probe?.cityName || probe?.name || null;
    const countryCode = String(
        result?.countryCode
        || result?.country_code
        || probe?.countryCode
        || probe?.country_code
        || probe?.country
        || fallbackLocation?.value
        || ''
    ).trim().toUpperCase();

    const label = city && countryCode
        ? `${city} (${countryCode})`
        : city
            ? city
            : countryCode
                ? countryCode
                : `Probe ${index + 1}`;

    return {
        code: countryCode || null,
        label
    };
}

function extractProbeResults(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;

    const candidates = [payload.results, payload.measurements, payload.probes, payload.data];
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate;
    }
    return [];
}

function getResultResponseTime(result) {
    if (!result || typeof result !== 'object') return null;

    // For ping, timings is an array [{rtt: N}, ...]; pick first packet rtt as fallback
    const pingFirstRtt = Array.isArray(result?.result?.timings) && result.result.timings.length > 0
        ? result.result.timings[0]?.rtt
        : null;

    const candidates = [
        result.responseTime,
        result.response_time,
        result.latency,
        result.time,
        result.duration,
        result.rtt,
        result?.timings?.total,
        result?.timings?.firstByte,
        result?.result?.responseTime,
        result?.result?.time,
        result?.result?.latency,
        result?.result?.rtt,
        result?.result?.stats?.avg,
        pingFirstRtt,
        result?.result?.timings?.total
    ];

    for (const value of candidates) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return Math.max(0, Math.round(value));
        }
    }
    return null;
}

function evaluateProbeResult(result, tool) {
    if (!result || typeof result !== 'object') {
        return { success: false, reason: 'No probe result returned' };
    }

    if (result.error || result.errorMessage || result.message === 'error') {
        return { success: false, reason: result.error || result.errorMessage || 'Probe error' };
    }

    const statusText = String(result.status || result.state || result.result?.status || '').toLowerCase();
    if (statusText.includes('in-progress') || statusText.includes('pending') || statusText.includes('queued')) {
        return { success: false, reason: `Probe status: ${statusText}` };
    }
    if (statusText.includes('fail') || statusText.includes('error') || statusText.includes('timeout')) {
        return { success: false, reason: `Probe status: ${statusText}` };
    }

    const nested = result.result || result;

    if (tool === 'http') {
        const statusCode = nested.statusCode || nested.status || nested.code;
        if (typeof statusCode === 'number') {
            const success = statusCode >= 200 && statusCode < 400;
            return { success, reason: `HTTP ${statusCode}` };
        }
    }

    if (tool === 'dns') {
        const answers = nested.answers || nested.answer;
        if (Array.isArray(answers)) {
            return { success: answers.length > 0, reason: answers.length > 0 ? 'DNS records returned' : 'No DNS answers' };
        }
    }

    if (tool === 'ping') {
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

async function fetchGlobalpingMeasurementResults(measurementId, headers, expectedCount, timeoutMs) {
    const fetchImpl = await getFetchImpl();
    const startedAt = Date.now();
    let lastResults = [];

    const isFinalProbeResult = (result) => {
        const statusText = String(result?.status || result?.state || result?.result?.status || '').toLowerCase();
        if (!statusText) return true;
        return !statusText.includes('in-progress')
            && !statusText.includes('pending')
            && !statusText.includes('queued');
    };

    while (Date.now() - startedAt < timeoutMs) {
        const response = await fetchImpl(`https://api.globalping.io/v1/measurements/${measurementId}`, { headers });
        if (response.ok) {
            const payload = await response.json();
            const results = extractProbeResults(payload);
            if (results.length > 0) {
                lastResults = results;
            }

            const enoughResults = results.length >= expectedCount;
            const allFinal = results.length > 0 && results.every(isFinalProbeResult);
            if (enoughResults && allFinal) {
                return results;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 1200));
    }

    return lastResults;
}

async function runGlobalpingTool({ tool, target, timeoutMs, locations, method, recordType, cycles, packetCount }) {
    if (!locations.length) return [];

    // Compute a realistic poll budget for how long to wait for the measurement to finish.
    // This is independent of the per-probe timeoutMs the user sets — some tools take much longer.
    let pollTimeoutMs;
    if (tool === 'mtr')        pollTimeoutMs = Math.max(45000, cycles * 3500 + 15000);
    else if (tool === 'ping') pollTimeoutMs = Math.max(20000, packetCount * 2000 + 8000);
    else                      pollTimeoutMs = Math.max(15000, timeoutMs + 8000); // http, dns, traceroute

    const fetchImpl = await getFetchImpl();
    const headers = { 'Content-Type': 'application/json' };
    if (GLOBALPING_API_KEY) headers.Authorization = `Bearer ${GLOBALPING_API_KEY}`;

    const payload = {
        type: tool,
        target,
        inProgressUpdates: true,
        locations: locations.map(location => ({ [location.type]: location.value, limit: 1 }))
    };

    // Globalping requires tool-specific options inside measurementOptions
    const measurementOptions = {};
    if (tool === 'http') measurementOptions.request = { method };
    if (tool === 'dns') measurementOptions.query = { type: recordType };
    if (tool === 'ping') measurementOptions.packets = Math.max(1, Math.min(16, packetCount));
    if (tool === 'mtr') measurementOptions.packets = Math.max(1, Math.min(16, cycles));
    if (Object.keys(measurementOptions).length > 0) payload.measurementOptions = measurementOptions;

    const response = await fetchImpl('https://api.globalping.io/v1/measurements', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        // Try to extract a readable error message from the body
        let apiMsg = '';
        try { apiMsg = JSON.parse(text)?.error?.message || JSON.parse(text)?.message || ''; } catch {}
        const detail = (apiMsg || text || '').slice(0, 200);
        return locations.map(location => ({
            ok: false,
            source: 'globalping',
            locationCode: location.value,
            locationLabel: location.value,
            responseTimeMs: null,
            reason: `API ${response.status}${detail ? `: ${detail}` : ''}`,
            raw: null
        }));
    }

    const body = await response.json().catch(() => null);
    // Always poll the measurement endpoint to get final results.
    // The POST response body may contain partial/in-progress probe data (especially with
    // inProgressUpdates:true), so we never shortcut directly from the POST body.
    let results = [];
    if (body?.id) {
        results = await fetchGlobalpingMeasurementResults(body.id, headers, locations.length, pollTimeoutMs);
    }
    // Fallback: use the POST body directly only if we didn't get an id to poll
    if (results.length === 0) {
        results = extractProbeResults(body);
    }

    if (results.length === 0) {
        return locations.map(location => ({
            ok: false,
            source: 'globalping',
            locationCode: location.value,
            locationLabel: location.value,
            responseTimeMs: null,
            reason: 'No probe payload was available',
            raw: null
        }));
    }

    return results.map((result, index) => {
        const evaluation = evaluateProbeResult(result, tool);
        const location = resolveProbeLocation(result, locations[index], index);
        return {
            ok: evaluation.success,
            source: 'globalping',
            locationCode: location.code || locations[index]?.value || null,
            locationLabel: location.label,
            responseTimeMs: getResultResponseTime(result),
            reason: evaluation.reason,
            raw: result
        };
    });
}

function extractHostForSocket(target) {
    const trimmed = String(target || '').trim();
    if (!trimmed) return trimmed;

    try {
        const url = new URL(trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`);
        return url.hostname;
    } catch {
        return trimmed;
    }
}

async function runLocalPing(target, timeoutMs) {
    const host = extractHostForSocket(target);
    const ports = [443, 80];

    for (const port of ports) {
        const result = await new Promise(resolve => {
            const socket = new net.Socket();
            const startedAt = Date.now();
            let finished = false;

            const done = (payload) => {
                if (finished) return;
                finished = true;
                socket.destroy();
                resolve(payload);
            };

            socket.setTimeout(timeoutMs, () => {
                done({ ok: false, responseTimeMs: null, reason: `TCP timeout on port ${port}` });
            });

            socket.once('error', () => {
                done({ ok: false, responseTimeMs: null, reason: `TCP connect failed on port ${port}` });
            });

            socket.connect(port, host, () => {
                done({ ok: true, responseTimeMs: Math.max(1, Date.now() - startedAt), reason: `TCP connect on port ${port}` });
            });
        });

        if (result.ok) return result;
    }

    return { ok: false, responseTimeMs: null, reason: 'Local ping simulation failed' };
}

async function runLocalHttp(target, timeoutMs, method) {
    const fetchImpl = await getFetchImpl();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const url = new URL(target.startsWith('http://') || target.startsWith('https://') ? target : `https://${target}`);
        const startedAt = Date.now();
        const response = await fetchImpl(url.toString(), {
            method,
            redirect: 'follow',
            signal: controller.signal
        });

        return {
            ok: response.ok,
            responseTimeMs: Math.max(1, Date.now() - startedAt),
            reason: `HTTP ${response.status}`
        };
    } catch (error) {
        const timedOut = String(error?.name || '').toLowerCase() === 'aborterror';
        return {
            ok: false,
            responseTimeMs: null,
            reason: timedOut ? 'Request timed out' : (error?.message || 'HTTP request failed')
        };
    } finally {
        clearTimeout(timeoutHandle);
    }
}

async function runLocalDns(target, recordType) {
    try {
        const startedAt = Date.now();
        const answers = await dns.resolve(target, recordType);
        return {
            ok: true,
            responseTimeMs: Math.max(1, Date.now() - startedAt),
            reason: answers.length > 0 ? 'DNS records returned' : 'No DNS answers',
            raw: answers
        };
    } catch (error) {
        return {
            ok: false,
            responseTimeMs: null,
            reason: error?.code || error?.message || 'DNS lookup failed'
        };
    }
}

async function runLocalTool({ tool, target, timeoutMs, method, recordType }) {
    if (tool === 'ping') return runLocalPing(target, timeoutMs);
    if (tool === 'http') return runLocalHttp(target, timeoutMs, method);
    if (tool === 'dns') return runLocalDns(target, recordType);

    return {
        ok: false,
        responseTimeMs: null,
        reason: 'Local execution for this tool is not supported. Use Globalping locations.'
    };
}

function appendJobResult(job, entry) {
    const sequence = job.results.length + 1;
    job.results.push({
        sequence,
        timestamp: new Date().toISOString(),
        ...entry
    });
    job.updatedAt = new Date().toISOString();
}

async function executeToolJob(job) {
    const localLocations = job.locations.filter(location => location.type === 'local');
    const globalLocations = job.locations.filter(location => location.type !== 'local');

    if (job.stopRequested) { markJobStopped(job); return; }

    // Run local locations (TCP-connect based)
    for (const location of localLocations) {
        if (job.stopRequested) { markJobStopped(job); return; }
        const localResult = await runLocalTool(job);
        appendJobResult(job, {
            packetIndex: 1,
            source: 'local',
            locationCode: location.value,
            locationLabel: 'This Server (LOCAL)',
            ok: Boolean(localResult.ok),
            responseTimeMs: localResult.responseTimeMs,
            reason: localResult.reason,
            raw: localResult.raw || null
        });
    }

    // Run Globalping locations — single measurement per tool (ping uses measurementOptions.packets)
    if (globalLocations.length > 0) {
        if (job.stopRequested) { markJobStopped(job); return; }
        const globalResults = await runGlobalpingTool({
            tool: job.tool,
            target: job.target,
            timeoutMs: job.timeoutMs,
            locations: globalLocations,
            method: job.method,
            recordType: job.recordType,
            maxHops: job.maxHops,
            cycles: job.cycles,
            packetCount: job.packetCount
        });

        globalResults.forEach(result => {
            appendJobResult(job, {
                packetIndex: 1,
                source: 'globalping',
                locationCode: result.locationCode,
                locationLabel: result.locationLabel,
                ok: Boolean(result.ok),
                responseTimeMs: result.responseTimeMs,
                reason: result.reason,
                raw: result.raw || null
            });
        });
    }

    job.progress.completed = 1;
    job.updatedAt = new Date().toISOString();

    if (job.stopRequested) { markJobStopped(job); return; }

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
}

router.post('/run', async (req, res) => {
    cleanupExpiredJobs();

    const tool = String(req.body?.tool || '').trim().toLowerCase();
    const target = normalizeTarget(req.body?.target);
    const timeoutMs = clampTimeout(req.body?.timeoutMs);
    const packetCount = clampInteger(req.body?.packetCount, 1, 1, TOOLS_MAX_PACKET_COUNT);
    const method = String(req.body?.method || 'GET').trim().toUpperCase();
    const recordType = String(req.body?.recordType || 'A').trim().toUpperCase();
    const maxHops = clampInteger(req.body?.maxHops, TOOLS_TRACEROUTE_MAX_HOPS, 1, 64);
    const cycles = clampInteger(req.body?.cycles, TOOLS_MTR_REPORT_CYCLES, 1, 20);
    const locations = normalizeLocations(req.body?.locations || []);

    if (!ALLOWED_TOOLS.has(tool)) return sendValidationError(res, 'Unsupported tool.');
    if (!target || target.length > 255) return sendValidationError(res, 'Target is required and must be <= 255 chars.');
    if (locations.length === 0) return sendValidationError(res, 'At least one location is required.');
    if (tool === 'http' && !ALLOWED_HTTP_METHODS.has(method)) return sendValidationError(res, 'Unsupported HTTP method.');
    if (tool === 'dns' && !ALLOWED_DNS_TYPES.has(recordType)) return sendValidationError(res, 'Unsupported DNS record type.');

    const jobId = crypto.randomUUID();
    const totalSteps = 1;
    const job = {
        id: jobId,
        userId: req.user.id,
        tool,
        target,
        timeoutMs,
        packetCount,
        method,
        recordType,
        maxHops,
        cycles,
        locations,
        status: 'running',
        progress: {
            completed: 0,
            total: totalSteps
        },
        results: [],
        error: null,
        stopRequested: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null
    };

    toolJobs.set(jobId, job);

    setImmediate(async () => {
        try {
            await executeToolJob(job);
        } catch (error) {
            job.status = 'failed';
            job.error = error?.message || 'Tool job failed';
            job.updatedAt = new Date().toISOString();
            job.completedAt = job.updatedAt;
        }
    });

    return res.status(202).json({ jobId });
});

router.post('/jobs/:id/stop', (req, res) => {
    cleanupExpiredJobs();
    const job = toolJobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'stopped') {
        return res.json({
            id: job.id,
            status: job.status,
            completedAt: job.completedAt,
            message: 'Job is already finished.'
        });
    }

    job.stopRequested = true;
    job.status = 'stopping';
    job.updatedAt = new Date().toISOString();

    return res.json({
        id: job.id,
        status: job.status,
        message: 'Stop requested.'
    });
});

router.get('/jobs/:id', (req, res) => {
    cleanupExpiredJobs();
    const job = toolJobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    return res.json({
        id: job.id,
        tool: job.tool,
        target: job.target,
        status: job.status,
        timeoutMs: job.timeoutMs,
        packetCount: job.packetCount,
        progress: job.progress,
        locations: job.locations,
        results: job.results,
        error: job.error,
        stopRequested: Boolean(job.stopRequested),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        completedAt: job.completedAt
    });
});

module.exports = router;
