// tests/tools.test.js
// CRITICAL: env vars must be set before any project module is required.
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), `uptime-tools-${Date.now()}-${crypto.randomUUID()}.sqlite`);
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-jwt-secret-tools';
process.env.ENABLE_LOCAL_FALLBACK = 'false';
process.env.FORCE_LOCAL_ONLY_MODE = 'false';
process.env.PASSWORD_MIN_LENGTH = '0';
process.env.TEST_MODE = 'true';
process.env.TOOLS_DEFAULT_TIMEOUT_MS = '3000';
process.env.TOOLS_MAX_TIMEOUT_MS = '5000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server.js');

let server, baseUrl, token;

before(async () => {
    await new Promise((resolve, reject) => {
        server = app.listen(0, () => {
            baseUrl = `http://localhost:${server.address().port}`;
            resolve();
        });
        server.once('error', reject);
    });
    await new Promise(r => setTimeout(r, 400));

    await fetch(`${baseUrl}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'tools@test.com', password: 'Password123!' })
    });
    const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'tools@test.com', password: 'Password123!' })
    });
    token = (await loginRes.json()).accessToken;
});

after(async () => {
    await new Promise(resolve => server.close(resolve));
    try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
});

function authHeaders() {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

async function startPingJob() {
    const res = await fetch(`${baseUrl}/api/tools/run`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            tool: 'ping',
            target: '127.0.0.1',
            locations: [{ value: 'LOCAL', type: 'local' }],
            timeoutMs: 3000
        })
    });
    const body = await res.json();
    return { status: res.status, jobId: body.jobId };
}

test('POST /api/tools/run returns 202 with jobId', async () => {
    const { status, jobId } = await startPingJob();
    assert.equal(status, 202);
    assert.ok(typeof jobId === 'string');
    assert.ok(jobId.length > 0);
});

test('GET /api/tools/jobs/:id returns job with status field', async () => {
    const { jobId } = await startPingJob();
    const res = await fetch(`${baseUrl}/api/tools/jobs/${jobId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body.status === 'string');
    assert.ok(['pending', 'running', 'stopping', 'completed', 'failed', 'stopped'].includes(body.status));
});

test('GET /api/tools/jobs/:nonexistent returns 404 with error JSON', async () => {
    const res = await fetch(`${baseUrl}/api/tools/jobs/nonexistent-job-id-xyz`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});

test('POST /api/tools/jobs/:id/stop accepts the request', async () => {
    const { jobId } = await startPingJob();
    const res = await fetch(`${baseUrl}/api/tools/jobs/${jobId}/stop`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    // Job may already be done by the time we stop it
    assert.ok([200, 400].includes(res.status), `Expected 200 or 400, got ${res.status}`);
});

test('POST /api/tools/run without auth returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/tools/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            tool: 'ping',
            target: '127.0.0.1',
            locations: [{ value: 'LOCAL', type: 'local' }]
        })
    });
    assert.equal(res.status, 401);
});

test('POST /api/tools/run with invalid tool type returns 400 with error JSON', async () => {
    const res = await fetch(`${baseUrl}/api/tools/run`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            tool: 'invalidtype',
            target: '127.0.0.1',
            locations: [{ value: 'LOCAL', type: 'local' }]
        })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});

test('POST /api/tools/run with missing target returns 400 with error JSON', async () => {
    const res = await fetch(`${baseUrl}/api/tools/run`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            tool: 'ping',
            locations: [{ value: 'LOCAL', type: 'local' }]
        })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});
