// src/routes/services.js

const express = require('express');
const { db } = require('../config/database');
const authenticateToken = require('../middleware/auth');
const { scheduleNextCheck, cancelCheck } = require('../services/scheduler');

const router = express.Router();

// All routes in this file are protected
router.use(authenticateToken);

router.get('/', (req, res) => {
    db.all('SELECT * FROM services WHERE user_id = ? ORDER BY name', [req.user.id], (err, rows) => {
        if (err) return res.status(500).send('Error fetching services.');
        res.json(rows);
    });
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
    const { name, type, target, interval, locations } = req.body;
    const locationsJson = JSON.stringify(locations);
    const sql = 'INSERT INTO services (user_id, name, type, target, interval, locations) VALUES (?, ?, ?, ?, ?, ?)';
    db.run(sql, [req.user.id, name, type, target, interval, locationsJson], function(err) {
        if (err) return res.status(500).send('Error adding service.');
        const newService = { id: this.lastID, user_id: req.user.id, name, type, target, interval, locations: locationsJson, lastChecked: null };
        scheduleNextCheck(newService);
        res.status(201).send({ id: this.lastID });
    });
});

router.put('/:id', (req, res) => {
    const { name, type, target, interval, locations } = req.body;
    const locationsJson = JSON.stringify(locations);
    const sql = `UPDATE services SET name = ?, type = ?, target = ?, interval = ?, locations = ? WHERE id = ? AND user_id = ?`;
    db.run(sql, [name, type, target, interval, locationsJson, req.params.id, req.user.id], function(err) {
        if (err) return res.status(500).send('Error updating service.');
        if (this.changes === 0) return res.status(404).send('Service not found or user not authorized.');
        const updatedService = { id: req.params.id, user_id: req.user.id, name, type, target, interval, locations: locationsJson, lastChecked: null };
        scheduleNextCheck(updatedService);
        res.status(200).send({ message: 'Service updated successfully.' });
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
