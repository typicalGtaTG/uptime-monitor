// src/routes/services.js

const express = require('express');
const { db } = require('../config/database');
const authenticateToken = require('../middleware/auth');
const { scheduleNextCheck, cancelCheck, getMonitoringStatus } = require('../services/scheduler');

const router = express.Router();

const ALLOWED_SERVICE_TYPES = new Set(['http', 'ping', 'dns']);

function normalizeLocations(locations) {
    if (!Array.isArray(locations)) return [];
    return locations
        .filter(location => location && typeof location === 'object')
        .map(location => ({
            value: String(location.value || '').trim().toUpperCase(),
            type: String(location.type || '').trim().toLowerCase()
        }))
        .filter(location => location.value && (location.type === 'country' || location.type === 'local'));
}

function validateServicePayload(payload) {
    const name = String(payload?.name || '').trim();
    const type = String(payload?.type || '').trim().toLowerCase();
    const target = String(payload?.target || '').trim();
    const interval = Number(payload?.interval);
    const locations = normalizeLocations(payload?.locations);

    if (name.length < 2 || name.length > 120) {
        return { error: 'Service name must be between 2 and 120 characters.' };
    }
    if (!ALLOWED_SERVICE_TYPES.has(type)) {
        return { error: 'Service type must be one of: http, ping, dns.' };
    }
    if (target.length < 2 || target.length > 255) {
        return { error: 'Target must be between 2 and 255 characters.' };
    }
    if (!Number.isInteger(interval) || interval < 30000 || interval > 86400000) {
        return { error: 'Interval must be an integer between 30000 and 86400000 milliseconds.' };
    }
    if (locations.length === 0) {
        return { error: 'At least one monitoring location is required.' };
    }

    const hasInvalidCountryCode = locations.some(location => location.type === 'country' && !/^[A-Z]{2}$/.test(location.value));
    if (hasInvalidCountryCode) {
        return { error: 'Country locations must use 2-letter country codes.' };
    }

    const hasInvalidLocalCode = locations.some(location => location.type === 'local' && location.value !== 'LOCAL');
    if (hasInvalidLocalCode) {
        return { error: 'Local location must use value LOCAL.' };
    }

    return {
        value: {
            name,
            type,
            target,
            interval,
            locations
        }
    };
}

// All routes in this file are protected
router.use(authenticateToken);

router.get('/', (req, res) => {
    db.all('SELECT * FROM services WHERE user_id = ? ORDER BY name', [req.user.id], (err, rows) => {
        if (err) return res.status(500).send('Error fetching services.');
        res.json(rows);
    });
});

router.get('/meta/monitoring', (_req, res) => {
    res.json(getMonitoringStatus());
});

router.get('/:id', (req, res) => {
    db.get('SELECT * FROM services WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], (err, row) => {
        if (err) return res.status(500).send('Error fetching service.');
        if (!row) return res.status(404).send('Service not found.');
        res.json(row);
    });
});

// ADDED BACK: The missing endpoint to get history for a service's graph
router.get('/:id/history', (req, res) => {
    // First, verify the user owns this service to prevent data leaks
    const serviceCheckSql = 'SELECT user_id FROM services WHERE id = ?';
    db.get(serviceCheckSql, [req.params.id], (err, service) => {
        if (err || !service || service.user_id !== req.user.id) {
            return res.status(404).send('Service not found or not authorized.');
        }
        
        // If authorized, get the last 30 history records
        const historySql = `
            SELECT * FROM status_history 
            WHERE service_id = ? 
            ORDER BY timestamp DESC 
            LIMIT 30`;
        db.all(historySql, [req.params.id], (err, rows) => {
            if (err) {
                return res.status(500).send('Error fetching service history.');
            }
            // Reverse the array so the chart shows the oldest data on the left
            res.json(rows.reverse());
        });
    });
});


router.post('/', (req, res) => {
    const validation = validateServicePayload(req.body);
    if (validation.error) return res.status(400).send(validation.error);

    const { name, type, target, interval, locations } = validation.value;
    const locationsJson = JSON.stringify(locations);
    const sql = 'INSERT INTO services (user_id, name, type, target, interval, locations) VALUES (?, ?, ?, ?, ?, ?)';
    db.run(sql, [req.user.id, name, type, target, interval, locationsJson], function(err) {
        if (err) return res.status(500).send('Error adding service.');
        db.get('SELECT * FROM services WHERE id = ? AND user_id = ?', [this.lastID, req.user.id], (readErr, service) => {
            if (!readErr && service) {
                scheduleNextCheck(service);
            }
            res.status(201).send({ id: this.lastID });
        });
    });
});

router.put('/:id', (req, res) => {
    const validation = validateServicePayload(req.body);
    if (validation.error) return res.status(400).send(validation.error);

    const { name, type, target, interval, locations } = validation.value;
    const locationsJson = JSON.stringify(locations);
    const sql = `UPDATE services SET name = ?, type = ?, target = ?, interval = ?, locations = ? WHERE id = ? AND user_id = ?`;
    db.run(sql, [name, type, target, interval, locationsJson, req.params.id, req.user.id], function(err) {
        if (err) return res.status(500).send('Error updating service.');
        if (this.changes === 0) return res.status(404).send('Service not found or user not authorized.');
        db.get('SELECT * FROM services WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], (readErr, service) => {
            if (!readErr && service) {
                scheduleNextCheck(service);
            }
            res.status(200).send({ message: 'Service updated successfully.' });
        });
    });
});

router.delete('/:id', (req, res) => {
    const sql = 'DELETE FROM services WHERE id = ? AND user_id = ?';
    db.run(sql, [req.params.id, req.user.id], function(err) {
        if (err) return res.status(500).send('Error deleting service.');
        if (this.changes === 0) return res.status(404).send('Service not found or user not authorized.');
        cancelCheck(req.params.id);
        res.sendStatus(204);
    });
});

module.exports = router;
