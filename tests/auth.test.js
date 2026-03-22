// tests/auth.test.js
// CRITICAL: env vars must be set before any project module is required.
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), `uptime-auth-${Date.now()}-${crypto.randomUUID()}.sqlite`);
process.env.DB_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-jwt-secret-auth';
process.env.ENABLE_LOCAL_FALLBACK = 'false';
process.env.FORCE_LOCAL_ONLY_MODE = 'false';
process.env.PASSWORD_MIN_LENGTH = '0';
process.env.TEST_MODE = 'true';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server.js');

let server, baseUrl;

before(async () => {
    await new Promise((resolve, reject) => {
        server = app.listen(0, () => {
            baseUrl = `http://localhost:${server.address().port}`;
            resolve();
        });
        server.once('error', reject);
    });
    // Allow SQLite migrations to complete
    await new Promise(r => setTimeout(r, 400));
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

async function registerAndLogin(email, password = 'Password123!') {
    await post('/api/register', { email, password });
    const res = await post('/api/login', { email, password });
    return (await res.json()).accessToken;
}

test('register a new user returns 201', async () => {
    const res = await post('/api/register', { email: 'reg1@test.com', password: 'Password123!' });
    assert.equal(res.status, 201);
});

test('register returns JSON body', async () => {
    const res = await post('/api/register', { email: 'reg2@test.com', password: 'Password123!' });
    const body = await res.json();
    assert.ok(typeof body === 'object');
});

test('register duplicate email returns 400 with error JSON', async () => {
    await post('/api/register', { email: 'dup@test.com', password: 'Password123!' });
    const res = await post('/api/register', { email: 'dup@test.com', password: 'Password123!' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(typeof body.error === 'string', 'error field should be a string');
});

test('register missing password returns 400 with error JSON', async () => {
    const res = await post('/api/register', { email: 'nopwd@test.com' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});

test('login with valid credentials returns accessToken', async () => {
    await post('/api/register', { email: 'login1@test.com', password: 'Password123!' });
    const res = await post('/api/login', { email: 'login1@test.com', password: 'Password123!' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body.accessToken === 'string');
    assert.ok(body.accessToken.length > 10);
});

test('login with wrong password returns 400 with error JSON', async () => {
    await post('/api/register', { email: 'login2@test.com', password: 'Password123!' });
    const res = await post('/api/login', { email: 'login2@test.com', password: 'WrongPassword' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
});

test('login with unknown email returns 400', async () => {
    const res = await post('/api/login', { email: 'nobody@test.com', password: 'Password123!' });
    assert.equal(res.status, 400);
});

test('GET /api/account with valid token returns account data', async () => {
    const token = await registerAndLogin('acct1@test.com');
    const res = await get('/api/account', token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.email, 'acct1@test.com');
});

test('GET /api/account without token returns 401', async () => {
    const res = await get('/api/account');
    assert.equal(res.status, 401);
});

test('GET /api/account with malformed token returns 401', async () => {
    const res = await get('/api/account', 'not-a-valid-token');
    assert.equal(res.status, 401);
});
