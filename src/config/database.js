// src/config/database.js

const sqlite3 = require('sqlite3').verbose();
const LATEST_SCHEMA_VERSION = 9;

const db = new sqlite3.Database(process.env.DB_PATH || './database.sqlite', (err) => {
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
            () => db.exec(`ALTER TABLE services ADD COLUMN locations TEXT;`),
            () => db.exec(`ALTER TABLE services ADD COLUMN uptime_24h REAL DEFAULT 100.0;`),
            () => db.exec(`
                ALTER TABLE services ADD COLUMN active_incident_since DATETIME;
                ALTER TABLE services ADD COLUMN last_incident_started DATETIME;
                ALTER TABLE services ADD COLUMN last_incident_ended DATETIME;
                ALTER TABLE services ADD COLUMN last_incident_reason TEXT;
                ALTER TABLE services ADD COLUMN last_check_source TEXT DEFAULT 'globalping';
            `),
            () => db.exec(`
                ALTER TABLE services ADD COLUMN is_degraded INTEGER DEFAULT 0;
                ALTER TABLE services ADD COLUMN active_degradation_since DATETIME;
                ALTER TABLE services ADD COLUMN last_degradation_started DATETIME;
                ALTER TABLE services ADD COLUMN last_degradation_ended DATETIME;
                ALTER TABLE services ADD COLUMN last_degradation_reason TEXT;
                ALTER TABLE services ADD COLUMN last_check_reason TEXT;

                ALTER TABLE status_history ADD COLUMN check_source TEXT DEFAULT 'globalping';
                ALTER TABLE status_history ADD COLUMN is_degraded INTEGER DEFAULT 0;
                ALTER TABLE status_history ADD COLUMN check_reason TEXT;
                ALTER TABLE status_history ADD COLUMN timed_out INTEGER DEFAULT 0;

                CREATE TABLE IF NOT EXISTS daily_rollups (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    service_id INTEGER NOT NULL,
                    date TEXT NOT NULL,
                    checks_total INTEGER NOT NULL DEFAULT 0,
                    checks_up INTEGER NOT NULL DEFAULT 0,
                    checks_down INTEGER NOT NULL DEFAULT 0,
                    checks_degraded INTEGER NOT NULL DEFAULT 0,
                    avg_response_time REAL DEFAULT 0,
                    max_response_time INTEGER DEFAULT 0,
                    FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
                    UNIQUE(service_id, date)
                );
            `),
            () => db.exec(`
                CREATE TABLE IF NOT EXISTS service_incidents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    service_id INTEGER NOT NULL,
                    started_at DATETIME NOT NULL,
                    ended_at DATETIME,
                    duration_ms INTEGER,
                    reason TEXT,
                    resolved_by TEXT,
                    start_check_source TEXT,
                    end_check_source TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_service_incidents_service_started
                ON service_incidents (service_id, started_at DESC);
            `),
            () => db.exec(`
                CREATE TABLE IF NOT EXISTS status_history_regions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    service_id INTEGER NOT NULL,
                    history_id INTEGER NOT NULL,
                    timestamp DATETIME NOT NULL,
                    location_label TEXT NOT NULL,
                    location_code TEXT,
                    status INTEGER NOT NULL,
                    response_time INTEGER NOT NULL,
                    check_source TEXT,
                    reason TEXT,
                    FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
                    FOREIGN KEY (history_id) REFERENCES status_history (id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_status_history_regions_service_time
                ON status_history_regions (service_id, timestamp DESC);
            `),
            () => db.exec(`
                ALTER TABLE services ADD COLUMN alerts_enabled INTEGER NOT NULL DEFAULT 0;

                CREATE TABLE IF NOT EXISTS webhooks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    url TEXT NOT NULL,
                    secret TEXT,
                    events TEXT NOT NULL DEFAULT '["service.down","service.recovered"]',
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_webhooks_user_id ON webhooks (user_id);
            `)
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
