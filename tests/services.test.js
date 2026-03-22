// tests/services.test.js
// CRITICAL: env vars must be set before any project module is required.
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), `uptime-services-${Date.now()}-${crypto.randomUUID()}.sqlite`);
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-jwt-secret-services';
process.env.ENABLE_LOCAL_FALLBACK = 'false';
process.env.FORCE_LOCAL_ONLY_MODE = 'false';
process.env.PASSWORD_MIN_LENGTH = '0';
process.env.TEST_MODE = 'true';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server.js');

let server, baseUrl, tokenA, tokenB, serviceId;

before(async () => {
    await new Promise((resolve, reject) => {
        server = app.listen(0, () => {
            baseUrl = `http://localhost:${server.address().port}`;
            resolve();
        });
        server.once('error', reject);
    });
    await new Promise(r => setTimeout(r, 400));

    async function registerAndLogin(email) {
        await post('/api/register', { email, password: 'Password123!' });
        const res = await post('/api/login', { email, password: 'Password123!' });
        return (await res.json()).accessToken;
    }
    tokenA = await registerAndLogin('userA@services.test');
    tokenB = await registerAndLogin('userB@services.test');
});

after(async () => {
    await new Promise(resolve => server.close(resolve));
    try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
});

function post(urlPath, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(`${baseUrl}${urlPath}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function get(urlPath, token) {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    return fetch(`${baseUrl}${urlPath}`, { headers });
}

function put(urlPath, body, token) {
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
    return fetch(`${baseUrl}${urlPath}`, { method: 'PUT', headers, body: JSON.stringify(body) });
}

function del(urlPath, token) {
    return fetch(`${baseUrl}${urlPath}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
}

const VALID_SERVICE = {
    name: 'Test HTTP Service',
    type: 'http',
    target: 'example.com',
    interval: 60000,
    locations: [{ value: 'LOCAL', type: 'local' }]
};

test('create service returns 201 with id', async () => {
    const res = await post('/api/services', VALID_SERVICE, tokenA);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(Number.isInteger(body.id));
    serviceId = body.id;
});

test('create service with short name returns 400 with error JSON', async () => {
    const res = await post('/api/services', { ...VALID_SERVICE, name: 'X' }, tokenA);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});

test('create service with invalid type returns 400 with error JSON', async () => {
    const res = await post('/api/services', { ...VALID_SERVICE, name: 'Test', type: 'ftp' }, tokenA);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});

test('create service with empty locations returns 400 with error JSON', async () => {
    const res = await post('/api/services', { ...VALID_SERVICE, name: 'No Locs', locations: [] }, tokenA);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});

test('create service without auth returns 401', async () => {
    const res = await post('/api/services', VALID_SERVICE);
    assert.equal(res.status, 401);
});

test('GET /api/services returns user A services array', async () => {
    const res = await get('/api/services', tokenA);
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.ok(Array.isArray(rows));
    assert.ok(rows.some(r => r.id === serviceId));
});

test('user B list does not contain user A services', async () => {
    const res = await get('/api/services', tokenB);
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.ok(!rows.some(r => r.id === serviceId));
});

test('user A can GET their own service by id', async () => {
    const res = await get(`/api/services/${serviceId}`, tokenA);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, serviceId);
});

test('user B GET user A service returns 404 with error JSON', async () => {
    const res = await get(`/api/services/${serviceId}`, tokenB);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});

test('user A can update their service', async () => {
    const res = await put(`/api/services/${serviceId}`, { ...VALID_SERVICE, name: 'Updated Name' }, tokenA);
    assert.equal(res.status, 200);
});

test('user B update user A service returns 404 with error JSON', async () => {
    const res = await put(`/api/services/${serviceId}`, { ...VALID_SERVICE, name: 'Hacked' }, tokenB);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});

test('user A can GET service history', async () => {
    const res = await get(`/api/services/${serviceId}/history`, tokenA);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
});

test('user B GET user A service history returns 404 with error JSON', async () => {
    const res = await get(`/api/services/${serviceId}/history`, tokenB);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});

test('user A can GET service details', async () => {
    const res = await get(`/api/services/${serviceId}/details`, tokenA);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.uptime);
    assert.ok(typeof body.uptime.last24h === 'number');
    assert.ok(typeof body.uptime.last7d === 'number');
});

test('user B GET user A service details returns 404', async () => {
    const res = await get(`/api/services/${serviceId}/details`, tokenB);
    assert.equal(res.status, 404);
});

test('user A can GET service incidents', async () => {
    const res = await get(`/api/services/${serviceId}/incidents`, tokenA);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.incidents));
    assert.ok(Number.isInteger(body.total));
});

test('user B GET user A service incidents returns 404', async () => {
    const res = await get(`/api/services/${serviceId}/incidents`, tokenB);
    assert.equal(res.status, 404);
});

test('user A can DELETE another of their services', async () => {
    const createRes = await post('/api/services', { ...VALID_SERVICE, name: 'To Delete' }, tokenA);
    const { id } = await createRes.json();
    const res = await del(`/api/services/${id}`, tokenA);
    assert.equal(res.status, 204);
});

test('user B DELETE user A service returns 404 with error JSON', async () => {
    const res = await del(`/api/services/${serviceId}`, tokenB);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});
