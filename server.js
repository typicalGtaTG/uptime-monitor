// server.js

require('dotenv').config();
const express = require('express');
const path = require('path');
const { initializeAllSchedules } = require('./src/services/scheduler');
const { db } = require('./src/config/database'); // Import db to ensure it's initialized

// --- App Setup ---
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Route Imports ---
const authRoutes = require('./src/routes/auth');
const serviceRoutes = require('./src/routes/services');

// --- Use Routes ---
app.use('/api', authRoutes);
app.use('/api/services', serviceRoutes);

// --- Start Server & Scheduler ---
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
