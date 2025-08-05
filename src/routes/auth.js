// src/routes/auth.js

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db } = require('../config/database');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-that-should-be-in-an-env-file';
const SALT_ROUNDS = 10;

router.post('/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).send('Email and password are required.');
    try {
        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
        db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, password_hash], function(err) {
            if (err) return res.status(400).send('This email is already registered.');
            res.status(201).send({ message: 'User registered successfully.' });
        });
    } catch (error) { res.status(500).send('Server error.'); }
});

router.post('/login', (req, res) => {
    const { email, password } = req.body;
    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err || !user) return res.status(400).send('Invalid credentials.');
        const match = await bcrypt.compare(password, user.password_hash);
        if (match) {
            const accessToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
            res.json({ accessToken });
        } else { res.status(400).send('Invalid credentials.'); }
    });
});

module.exports = router;
