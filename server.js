// server.js

require('dotenv').config();
const express = require('express');
const path = require('path');
const { initializeAllSchedules, getMonitoringStatus } = require('./src/services/scheduler');
const { db } = require('./src/config/database'); // Import db to ensure it's initialized

// --- App Setup ---
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Request Logging ---
app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

app.get('/tv', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tv.html'));
});

app.get('/api/health', (_req, res) => {
    const basePayload = {
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        monitoring: getMonitoringStatus()
    };

    db.get('SELECT 1 AS ok', [], (err) => {
        if (err) {
            return res.status(503).json({
                ok: false,
                database: 'down',
                ...basePayload
            });
        }

        return res.json({
            ok: true,
            database: 'up',
            ...basePayload
        });
    });
});

// --- Route Imports ---
const authRoutes = require('./src/routes/auth');
const serviceRoutes = require('./src/routes/services');
const toolsRoutes = require('./src/routes/tools');
const webhookRoutes = require('./src/routes/webhooks');

// --- Use Routes ---
app.use('/api', authRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/webhooks', webhookRoutes);

// --- Start Server & Scheduler ---
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);

        // Once the server is up, initialize the monitoring schedules
        // We wait a bit to ensure the database is fully ready after migrations.
        setTimeout(() => {
            initializeAllSchedules();
        }, 1000);

        if (!process.env.GLOBALPING_API_KEY) {
            console.warn('WARNING: GLOBALPING_API_KEY is not set. Using anonymous access with limited requests.');
        } else {
            console.log('Globalping API key found. Using authenticated access.');
        }
    });
}

module.exports = { app };
