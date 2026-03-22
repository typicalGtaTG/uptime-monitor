// src/routes/auth.js

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { db } = require('../config/database');
const authenticateToken = require('../middleware/auth');

const execAsync = promisify(exec);

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-that-should-be-in-an-env-file';
const SALT_ROUNDS = 10;
const GLOBALPING_MONTHLY_CREDIT_LIMIT = Math.max(1, Number(process.env.GLOBALPING_MONTHLY_CREDIT_LIMIT || 10000));
const PASSWORD_MIN_LENGTH = Math.max(0, Number(process.env.PASSWORD_MIN_LENGTH || 0));

function getMonthlyPeriodStartIso() {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    return start.toISOString();
}

function getUserById(userId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT id, email, password_hash FROM users WHERE id = ?', [userId], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

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

async function getGlobalpingUsageForUser(userId) {
    const periodStart = getMonthlyPeriodStartIso();
    const usageRow = await getAsync(
        `SELECT COUNT(*) AS used
         FROM status_history AS h
         INNER JOIN services AS s ON s.id = h.service_id
         WHERE s.user_id = ?
           AND h.check_source = 'globalping'
           AND h.timestamp >= ?`,
        [userId, periodStart]
    );

    const used = Number(usageRow?.used || 0);
    const limit = GLOBALPING_MONTHLY_CREDIT_LIMIT;
    const usagePercent = Number(Math.min(100, (used / limit) * 100).toFixed(2));

    return {
        used,
        limit,
        usagePercent,
        periodStart,
        estimated: true,
        hasApiKeyConfigured: Boolean(process.env.GLOBALPING_API_KEY)
    };
}

function toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

async function sampleCpuUsagePercent(sampleMs = 180) {
    const getCpuSnapshot = () => {
        const cpus = os.cpus() || [];
        return cpus.reduce((accumulator, cpu) => {
            const times = cpu?.times || {};
            const idle = Number(times.idle || 0);
            const total = Object.values(times).reduce((sum, value) => sum + Number(value || 0), 0);
            return {
                idle: accumulator.idle + idle,
                total: accumulator.total + total
            };
        }, { idle: 0, total: 0 });
    };

    const start = getCpuSnapshot();
    await new Promise(resolve => setTimeout(resolve, sampleMs));
    const end = getCpuSnapshot();

    const idleDelta = end.idle - start.idle;
    const totalDelta = end.total - start.total;
    if (totalDelta <= 0) return 0;

    const usagePercent = (1 - (idleDelta / totalDelta)) * 100;
    return Number(Math.max(0, Math.min(100, usagePercent)).toFixed(2));
}

async function getDiskUsageStats() {
    const cwd = process.cwd();

    if (process.platform === 'win32') {
        const drive = path.parse(cwd).root.replace(/\\/g, '').toUpperCase().replace(/:$/, '');
        const { stdout } = await execAsync('wmic logicaldisk get Caption,FreeSpace,Size /format:csv');
        const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const targetPrefix = `,${drive}:,`;
        const row = lines.find(line => line.toUpperCase().includes(targetPrefix));
        if (!row) throw new Error('Disk stats unavailable');

        const parts = row.split(',');
        const freeBytes = toNumber(parts[2]);
        const totalBytes = toNumber(parts[3]);
        if (!freeBytes || !totalBytes || totalBytes <= 0) throw new Error('Disk stats unavailable');

        const usedBytes = totalBytes - freeBytes;
        const usagePercent = Number(((usedBytes / totalBytes) * 100).toFixed(2));

        return {
            mount: `${drive}:`,
            totalBytes,
            usedBytes,
            freeBytes,
            usagePercent
        };
    }

    const safeCwd = cwd.replace(/"/g, '\\"');
    const { stdout } = await execAsync(`df -kP "${safeCwd}"`);
    const rows = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const line = rows[1];
    if (!line) throw new Error('Disk stats unavailable');

    const cols = line.split(/\s+/);
    const totalKb = toNumber(cols[1]);
    const usedKb = toNumber(cols[2]);
    const availKb = toNumber(cols[3]);
    const mount = cols[5] || '/';
    if (!totalKb || !usedKb || totalKb <= 0) throw new Error('Disk stats unavailable');

    const totalBytes = totalKb * 1024;
    const usedBytes = usedKb * 1024;
    const freeBytes = (availKb || 0) * 1024;
    const usagePercent = Number(((usedBytes / totalBytes) * 100).toFixed(2));

    return {
        mount,
        totalBytes,
        usedBytes,
        freeBytes,
        usagePercent
    };
}

async function getRuntimeStats() {
    const totalSystemMemory = os.totalmem();
    const freeSystemMemory = os.freemem();
    const usedSystemMemory = Math.max(0, totalSystemMemory - freeSystemMemory);
    const systemMemoryPercent = totalSystemMemory > 0
        ? Number(((usedSystemMemory / totalSystemMemory) * 100).toFixed(2))
        : 0;

    const processMemory = process.memoryUsage();
    const cpuPercent = await sampleCpuUsagePercent();

    let disk = {
        mount: process.platform === 'win32' ? path.parse(process.cwd()).root.replace(/\\/g, '').replace(':', '') + ':' : '/',
        totalBytes: null,
        usedBytes: null,
        freeBytes: null,
        usagePercent: null,
        unavailable: true
    };

    try {
        disk = {
            ...(await getDiskUsageStats()),
            unavailable: false
        };
    } catch {
        // Keep unavailable payload shape stable.
    }

    return {
        generatedAt: new Date().toISOString(),
        node: {
            version: process.version,
            uptimeSeconds: Math.floor(process.uptime()),
            memory: {
                rssBytes: processMemory.rss,
                heapTotalBytes: processMemory.heapTotal,
                heapUsedBytes: processMemory.heapUsed,
                externalBytes: processMemory.external,
                arrayBuffersBytes: processMemory.arrayBuffers || 0
            }
        },
        system: {
            platform: process.platform,
            cpuCount: (os.cpus() || []).length,
            cpuUsagePercent: cpuPercent,
            memory: {
                totalBytes: totalSystemMemory,
                usedBytes: usedSystemMemory,
                freeBytes: freeSystemMemory,
                usagePercent: systemMemoryPercent
            },
            disk
        }
    };
}

router.post('/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (PASSWORD_MIN_LENGTH > 0 && String(password).length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
    }
    try {
        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
        db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, password_hash], function(err) {
            if (err) return res.status(400).json({ error: 'This email is already registered.' });
            res.status(201).json({ message: 'User registered successfully.' });
        });
    } catch (error) { res.status(500).json({ error: 'Server error.' }); }
});

router.post('/login', (req, res) => {
    const { email, password } = req.body;
    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'Invalid credentials.' });
        const match = await bcrypt.compare(password, user.password_hash);
        if (match) {
            const accessToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
            res.json({ accessToken });
        } else { res.status(400).json({ error: 'Invalid credentials.' }); }
    });
});

router.get('/account', authenticateToken, async (req, res) => {
    try {
        const user = await getUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'Account not found.' });

        const globalpingUsage = await getGlobalpingUsageForUser(req.user.id);
        const runtimeStats = await getRuntimeStats();
        res.json({
            email: user.email,
            globalpingUsage,
            runtimeStats
        });
    } catch {
        res.status(500).json({ error: 'Error fetching account settings.' });
    }
});

router.put('/account/email', authenticateToken, async (req, res) => {
    const nextEmail = String(req.body?.email || '').trim().toLowerCase();
    const currentPassword = String(req.body?.currentPassword || '');

    if (!nextEmail || !currentPassword) {
        return res.status(400).json({ error: 'Email and current password are required.' });
    }

    try {
        const user = await getUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'Account not found.' });

        const matches = await bcrypt.compare(currentPassword, user.password_hash);
        if (!matches) return res.status(400).json({ error: 'Current password is invalid.' });

        await runAsync('UPDATE users SET email = ? WHERE id = ?', [nextEmail, req.user.id]);
        res.json({ message: 'Email updated successfully.' });
    } catch (error) {
        if (String(error?.message || '').includes('UNIQUE')) {
            return res.status(400).json({ error: 'That email is already in use.' });
        }
        res.status(500).json({ error: 'Could not update email.' });
    }
});

router.put('/account/password', authenticateToken, async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const nextPassword = String(req.body?.newPassword || '');

    if (!currentPassword || !nextPassword) {
        return res.status(400).json({ error: 'Current password and new password are required.' });
    }
    if (PASSWORD_MIN_LENGTH > 0 && nextPassword.length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({ error: `New password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
    }

    try {
        const user = await getUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'Account not found.' });

        const matches = await bcrypt.compare(currentPassword, user.password_hash);
        if (!matches) return res.status(400).json({ error: 'Current password is invalid.' });

        const passwordHash = await bcrypt.hash(nextPassword, SALT_ROUNDS);
        await runAsync('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.user.id]);
        res.json({ message: 'Password updated successfully.' });
    } catch {
        res.status(500).json({ error: 'Could not update password.' });
    }
});

module.exports = router;
