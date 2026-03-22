// src/routes/webhooks.js

const express = require('express');
const crypto = require('crypto');
const { db } = require('../config/database');
const authenticateToken = require('../middleware/auth');
const { dispatchAlerts } = require('../services/alerts');

const router = express.Router();
router.use(authenticateToken);

const ALLOWED_EVENTS = new Set(['service.down', 'service.recovered', 'service.degraded']);

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

function validateWebhookPayload(body) {
    const name = String(body?.name || '').trim();
    const url = String(body?.url || '').trim();
    const secret = body?.secret != null ? String(body.secret).trim() : null;
    const rawEvents = Array.isArray(body?.events) ? body.events : ['service.down', 'service.recovered'];
    const is_active = body?.is_active !== undefined ? (body.is_active ? 1 : 0) : 1;

    if (name.length < 1 || name.length > 80) {
        return { error: 'Webhook name must be between 1 and 80 characters.' };
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { error: 'Webhook URL must use http or https.' };
        }
        // Block SSRF to private/local networks
        const hostname = parsed.hostname.toLowerCase();
        if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '::1' ||
            hostname.startsWith('10.') ||
            hostname.startsWith('192.168.') ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
            hostname.endsWith('.local') ||
            hostname.endsWith('.internal')
        ) {
            return { error: 'Webhook URL cannot target private or local network addresses.' };
        }
    } catch {
        return { error: 'Webhook URL is not valid.' };
    }
    if (secret !== null && secret.length > 256) {
        return { error: 'Webhook secret must be 256 characters or fewer.' };
    }

    const events = rawEvents.filter(e => ALLOWED_EVENTS.has(String(e)));
    if (events.length === 0) {
        return { error: 'At least one valid event must be selected (service.down, service.recovered, service.degraded).' };
    }

    return { value: { name, url, secret: secret || null, events, is_active } };
}

// GET /api/webhooks — list all webhooks for the user
router.get('/', async (req, res) => {
    try {
        const rows = await allAsync(
            `SELECT id, name, url, secret, events, is_active, created_at
             FROM webhooks WHERE user_id = ? ORDER BY created_at ASC`,
            [req.user.id]
        );
        res.json(rows.map(row => ({
            ...row,
            events: (() => { try { return JSON.parse(row.events); } catch { return []; } })(),
            // Mask secret: only indicate if one is set
            has_secret: Boolean(row.secret),
            secret: undefined
        })));
    } catch (err) {
        res.status(500).json({ error: 'Error fetching webhooks.' });
    }
});

// POST /api/webhooks — create webhook
router.post('/', async (req, res) => {
    const validation = validateWebhookPayload(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { name, url, secret, events, is_active } = validation.value;

    try {
        const result = await runAsync(
            `INSERT INTO webhooks (user_id, name, url, secret, events, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
            [req.user.id, name, url, secret, JSON.stringify(events), is_active]
        );
        const row = await getAsync('SELECT id, name, url, events, is_active, created_at FROM webhooks WHERE id = ?', [result.lastID]);
        res.status(201).json({
            ...row,
            events: (() => { try { return JSON.parse(row.events); } catch { return []; } })(),
            has_secret: Boolean(secret)
        });
    } catch (err) {
        res.status(500).json({ error: 'Error creating webhook.' });
    }
});

// PUT /api/webhooks/:id — update webhook
router.put('/:id', async (req, res) => {
    const validation = validateWebhookPayload(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { name, url, secret, events, is_active } = validation.value;

    try {
        const existing = await getAsync('SELECT id FROM webhooks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!existing) return res.status(404).json({ error: 'Webhook not found.' });

        // If secret is empty string and existing has one, keep existing secret (don't clear it)
        // If body sends 'secret' as non-null non-empty string, update it
        // This allows intentional clear via explicit null
        const secretToStore = (req.body?.secret === null) ? null : (secret || undefined);
        const updateSql = secretToStore !== undefined
            ? `UPDATE webhooks SET name = ?, url = ?, secret = ?, events = ?, is_active = ? WHERE id = ? AND user_id = ?`
            : `UPDATE webhooks SET name = ?, url = ?, events = ?, is_active = ? WHERE id = ? AND user_id = ?`;
        const updateParams = secretToStore !== undefined
            ? [name, url, secretToStore, JSON.stringify(events), is_active, req.params.id, req.user.id]
            : [name, url, JSON.stringify(events), is_active, req.params.id, req.user.id];

        await runAsync(updateSql, updateParams);
        const row = await getAsync('SELECT id, name, url, secret, events, is_active, created_at FROM webhooks WHERE id = ?', [req.params.id]);
        res.json({
            ...row,
            events: (() => { try { return JSON.parse(row.events); } catch { return []; } })(),
            has_secret: Boolean(row.secret),
            secret: undefined
        });
    } catch (err) {
        res.status(500).json({ error: 'Error updating webhook.' });
    }
});

// DELETE /api/webhooks/:id — delete webhook
router.delete('/:id', async (req, res) => {
    try {
        const existing = await getAsync('SELECT id FROM webhooks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!existing) return res.status(404).json({ error: 'Webhook not found.' });
        await runAsync('DELETE FROM webhooks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        res.sendStatus(204);
    } catch (err) {
        res.status(500).json({ error: 'Error deleting webhook.' });
    }
});

// POST /api/webhooks/:id/test — send a test payload
router.post('/:id/test', async (req, res) => {
    try {
        const webhook = await getAsync('SELECT * FROM webhooks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!webhook) return res.status(404).json({ error: 'Webhook not found.' });

        // Use the shared alert dispatcher which handles Discord vs generic format automatically
        const fakeService = {
            id: 0,
            user_id: req.user.id,
            name: 'Test Service',
            type: 'http',
            target: 'example.com',
            status: 'Down',
            alerts_enabled: 1
        };

        const crypto2 = require('crypto');
        const payload = {
            event: 'service.down',
            timestamp: new Date().toISOString(),
            service: { id: fakeService.id, name: fakeService.name, type: fakeService.type, target: fakeService.target, status: fakeService.status },
            reason: 'This is a test webhook delivery from uptime-monitor.'
        };
        const payloadJson = JSON.stringify(payload);

        // Validate URL before dispatch (SSRF check)
        const urlCheck = validateWebhookPayload({ name: webhook.name, url: webhook.url, events: ['service.down'] });
        if (urlCheck.error) return res.status(400).json({ error: urlCheck.error });

        // Detect Discord and build appropriate body
        const isDiscord = (() => {
            try {
                const h = new URL(webhook.url).hostname.toLowerCase();
                return h === 'discord.com' || h === 'discordapp.com' || h === 'ptb.discord.com' || h === 'canary.discord.com';
            } catch { return false; }
        })();

        let body;
        if (isDiscord) {
            body = JSON.stringify({
                embeds: [{
                    title: '🔴 Test — Service Down',
                    color: 0xE53E3E,
                    fields: [
                        { name: 'Service', value: fakeService.name, inline: true },
                        { name: 'Target', value: fakeService.target, inline: true },
                        { name: 'Type', value: fakeService.type.toUpperCase(), inline: true },
                        { name: 'Reason', value: payload.reason, inline: false }
                    ],
                    footer: { text: 'uptime-monitor — test delivery' },
                    timestamp: payload.timestamp
                }]
            });
        } else {
            body = payloadJson;
        }

        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'uptime-monitor/1.0',
            'X-Webhook-Test': 'true'
        };
        if (webhook.secret && !isDiscord) {
            const sig = crypto2.createHmac('sha256', webhook.secret).update(payloadJson).digest('hex');
            headers['X-Webhook-Signature'] = `sha256=${sig}`;
        }

        const fetchMod = await import('node-fetch');
        const fetchFn = fetchMod.default;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const httpRes = await fetchFn(webhook.url, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal
        });
        clearTimeout(timer);

        res.json({ ok: true, status: httpRes.status, statusText: httpRes.statusText });
    } catch (err) {
        res.status(502).json({ ok: false, error: err.message || 'Webhook delivery failed.' });
    }
});

module.exports = router;
