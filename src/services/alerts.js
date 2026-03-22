// src/services/alerts.js

const { db } = require('../config/database');
const crypto = require('crypto');

function allAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function getFetch() {
    const mod = await import('node-fetch');
    return mod.default;
}

const EVENT_LABELS = {
    'service.down': '🔴 Service Down',
    'service.recovered': '🟢 Service Recovered',
    'service.degraded': '🟡 Service Degraded'
};

const EVENT_COLORS = {
    'service.down': 0xE53E3E,
    'service.recovered': 0x38A169,
    'service.degraded': 0xD69E2E
};

function isDiscordUrl(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return hostname === 'discord.com' || hostname === 'discordapp.com' || hostname === 'ptb.discord.com' || hostname === 'canary.discord.com';
    } catch { return false; }
}

function buildDiscordPayload(service, event, reason, payloadObj) {
    const title = EVENT_LABELS[event] || event;
    const color = EVENT_COLORS[event] || 0x718096;
    const fields = [
        { name: 'Service', value: service.name, inline: true },
        { name: 'Target', value: service.target, inline: true },
        { name: 'Type', value: (service.type || '').toUpperCase(), inline: true }
    ];
    if (reason) fields.push({ name: 'Reason', value: reason, inline: false });

    return JSON.stringify({
        embeds: [{
            title,
            color,
            fields,
            footer: { text: 'uptime-monitor' },
            timestamp: payloadObj.timestamp
        }]
    });
}

/**
 * Dispatches webhook notifications for a service state change event.
 * Called from the scheduler after each check that results in a status transition.
 *
 * @param {object} service   - The full service row (must include user_id, alerts_enabled)
 * @param {string} event     - One of: 'service.down', 'service.recovered', 'service.degraded'
 * @param {string} reason    - Human-readable reason string
 */
async function dispatchAlerts(service, event, reason) {
    if (!service.alerts_enabled) return;

    let webhooks;
    try {
        webhooks = await allAsync(
            `SELECT id, name, url, secret, events FROM webhooks
             WHERE user_id = ? AND is_active = 1`,
            [service.user_id]
        );
    } catch (err) {
        console.warn(` -> [ALERTS] Could not load webhooks: ${err.message}`);
        return;
    }

    if (!webhooks || webhooks.length === 0) return;

    const payload = {
        event,
        timestamp: new Date().toISOString(),
        service: {
            id: service.id,
            name: service.name,
            type: service.type,
            target: service.target,
            status: service.status
        },
        reason: reason || null
    };

    const payloadJson = JSON.stringify(payload);
    const fetchFn = await getFetch();

    for (const webhook of webhooks) {
        let events = [];
        try { events = JSON.parse(webhook.events || '[]'); } catch { continue; }
        if (!events.includes(event)) continue;

        try {
            const discord = isDiscordUrl(webhook.url);
            // Discord requires its own embed payload format; generic webhooks get our JSON envelope
            const body = discord
                ? buildDiscordPayload(service, event, reason, payload)
                : payloadJson;

            const headers = {
                'Content-Type': 'application/json',
                'User-Agent': 'uptime-monitor/1.0'
            };
            // Only sign non-Discord webhooks (Discord ignores the header and it adds noise)
            if (webhook.secret && !discord) {
                const sig = crypto.createHmac('sha256', webhook.secret).update(payloadJson).digest('hex');
                headers['X-Webhook-Signature'] = `sha256=${sig}`;
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            const res = await fetchFn(webhook.url, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal
            });
            clearTimeout(timer);
            console.log(` -> [WEBHOOK] "${webhook.name}": ${event} -> HTTP ${res.status}`);
        } catch (err) {
            console.warn(` -> [WEBHOOK] "${webhook.name}": delivery failed: ${err.message}`);
        }
    }
}

module.exports = { dispatchAlerts };
