// src/config/database.js

const sqlite3 = require('sqlite3').verbose();
const LATEST_SCHEMA_VERSION = 3;

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Error opening database', err.message);
        process.exit(1);
    } else {
        console.log('Connected to the SQLite database.');
        runMigrations();
    }
});

function runMigrations() {
    console.log('Checking database schema version...');
    db.get("PRAGMA user_version;", (err, row) => {
        if (err) {
            console.error("Failed to get DB version", err);
            return;
        }
        
        let currentVersion = row.user_version;
        console.log(`Current DB version: ${currentVersion}`);

        if (currentVersion >= LATEST_SCHEMA_VERSION) {
            console.log('Database schema is up to date.');
            return;
        }

        console.log('Database schema is outdated. Running migrations...');
        const migrations = [
            () => db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL, interval INTEGER NOT NULL, status TEXT DEFAULT 'Pending', lastChecked DATETIME, FOREIGN KEY (user_id) REFERENCES users (id));`),
            () => db.exec(`ALTER TABLE services ADD COLUMN lastResponseTime INTEGER; CREATE TABLE IF NOT EXISTS status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, service_id INTEGER NOT NULL, timestamp DATETIME NOT NULL, status INTEGER NOT NULL, response_time INTEGER NOT NULL, FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE);`),
            () => db.exec(`ALTER TABLE services ADD COLUMN locations TEXT;`)
        ];

        db.serialize(() => {
            for (let i = currentVersion; i < LATEST_SCHEMA_VERSION; i++) {
                try {
                    console.log(`Running migration for version ${i + 1}...`);
                    migrations[i]();
                    db.run(`PRAGMA user_version = ${i + 1};`);
                    console.log(`Successfully migrated to version ${i + 1}.`);
                } catch (migrationErr) {
                     console.error(`Failed to run migration for version ${i + 1}`, migrationErr);
                     process.exit(1);
                }
            }
            console.log('All migrations completed successfully.');
        });
    });
}

module.exports = { db };
