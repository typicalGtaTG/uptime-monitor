// src/services/scheduler.js

const { db } = require('../config/database');
const GLOBALPING_API_KEY = process.env.GLOBALPING_API_KEY;

const activeTimers = {};

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
    activeTimers[service.id] = setTimeout(() => performCheck(service), delay);
}

function cancelCheck(serviceId) {
    if (activeTimers[serviceId]) {
        clearTimeout(activeTimers[serviceId]);
        delete activeTimers[serviceId];
        console.log(` -> Canceled scheduled check for service ID: ${serviceId}`);
    }
}

async function performCheck(service) {
    const fetch = (await import('node-fetch')).default;
    console.log(` -> [RUNNING] Checking ${service.name} (${service.target})`);
    
    const locations = JSON.parse(service.locations || '[]');
    if (locations.length === 0) {
        const updatedService = { ...service, lastChecked: new Date().toISOString() };
        scheduleNextCheck(updatedService);
        return;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (GLOBALPING_API_KEY) headers['Authorization'] = `Bearer ${GLOBALPING_API_KEY}`;

    const payload = {
        type: service.type,
        target: service.target,
        locations: locations.map(loc => ({ [loc.type]: loc.value, limit: 1 }))
    };

    const startTime = Date.now();
    let isUp = false;
    let averageResponseTime = 0;

    try {
        const response = await fetch('https://api.globalping.io/v1/measurements', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });
        isUp = response.ok;
        averageResponseTime = Date.now() - startTime;
    } catch (err) {
        isUp = false;
    }
    
    const now = new Date();
    const statusText = isUp ? 'Up' : 'Down';

    // Insert current check into history
    db.run(`INSERT INTO status_history (service_id, timestamp, status, response_time) VALUES (?, ?, ?, ?)`, 
        [service.id, now.toISOString(), isUp ? 1 : 0, averageResponseTime]);

    // Calculate 24-hour uptime
    const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000)).toISOString();
    db.all(`SELECT status FROM status_history WHERE service_id = ? AND timestamp >= ?`, [service.id, twentyFourHoursAgo], (err, rows) => {
        if (err) return console.error(`Error calculating uptime for ${service.name}:`, err);
        
        const upCount = rows.filter(r => r.status === 1).length;
        const totalCount = rows.length;
        const uptimePercentage = totalCount > 0 ? (upCount / totalCount) * 100 : 100;

        // Update the main service entry with status and new uptime stat
        db.run(`UPDATE services SET status = ?, lastChecked = ?, lastResponseTime = ?, uptime_24h = ? WHERE id = ?`, 
            [statusText, now.toISOString(), averageResponseTime, uptimePercentage.toFixed(2), service.id]);
        
        console.log(` -> [RESULT] for ${service.name}: ${statusText} (${averageResponseTime}ms) - 24h Uptime: ${uptimePercentage.toFixed(2)}%`);
    });

    const updatedService = { ...service, lastChecked: now.toISOString() };
    scheduleNextCheck(updatedService);
}

module.exports = {
    initializeAllSchedules,
    scheduleNextCheck,
    cancelCheck
};
