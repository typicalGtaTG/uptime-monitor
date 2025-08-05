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
        console.log(` -> [SKIPPED] No locations configured for ${service.name}`);
        const updatedService = { ...service, lastChecked: new Date().toISOString() };
        scheduleNextCheck(updatedService);
        return;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (GLOBALPING_API_KEY) headers['Authorization'] = `Bearer ${GLOBALPING_API_KEY}`;

    const checkPromises = locations.map(location => {
        const startTime = Date.now();
        
        // THE FIX IS HERE:
        // The API expects an array of location objects. For a single check,
        // we create an array with one object in the correct format.
        const payload = {
            type: service.type,
            target: service.target,
            locations: [{
                [location.type]: location.value, // Creates { "country": "DE" }
                limit: 1
            }]
        };

        return fetch('https://api.globalping.io/v1/measurements', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        }).then(async response => {
            const responseTime = Date.now() - startTime;
            if (!response.ok) {
                const errorBody = await response.json().catch(() => ({}));
                const errorMessage = errorBody.error?.message || errorBody.message || 'Unknown error';
                return { ok: false, status: response.status, responseTime, error: errorMessage, location: location.value };
            }
            return { ok: true, status: response.status, responseTime, location: location.value };
        }).catch(err => ({ ok: false, status: 500, responseTime: 0, error: err.message, location: location.value }));
    });

    const results = await Promise.all(checkPromises);
    const successfulChecks = results.filter(r => r.ok);
    const failedChecks = results.filter(r => !r.ok);
    
    if(failedChecks.length > 0) {
        console.log(` -> [DEBUG] Failed checks for ${service.name}:`);
        failedChecks.forEach(f => console.log(`    - Location: ${f.location}, Status: ${f.status}, Error: ${f.error}`));
    }
    
    const isUp = successfulChecks.length > 0;
    const statusText = isUp ? 'Up' : 'Down';
    const now = new Date().toISOString();
    
    const totalResponseTime = successfulChecks.reduce((sum, r) => sum + r.responseTime, 0);
    const averageResponseTime = successfulChecks.length > 0 ? Math.round(totalResponseTime / successfulChecks.length) : 0;

    db.run(`UPDATE services SET status = ?, lastChecked = ?, lastResponseTime = ? WHERE id = ?`, [statusText, now, averageResponseTime, service.id]);
    db.run(`INSERT INTO status_history (service_id, timestamp, status, response_time) VALUES (?, ?, ?, ?)`, [service.id, now, isUp ? 1 : 0, averageResponseTime]);

    console.log(` -> [RESULT] for ${service.name}: ${statusText} (${averageResponseTime}ms avg) - ${successfulChecks.length}/${locations.length} locations succeeded`);
    const updatedService = { ...service, lastChecked: now };
    scheduleNextCheck(updatedService);
}

module.exports = {
    initializeAllSchedules,
    scheduleNextCheck,
    cancelCheck
};
