import { apiFetch } from './api.js';

const REFRESH_MS = 30000;
const EVENT_LIMIT = 40;
let refreshTimer;
let clockTimer;
let nextRefreshAt = 0;
let lastMode = 'global';
const previousSnapshots = new Map();
const events = [];

function pushEvent(level, message) {
    const now = new Date();
    events.unshift({
        level,
        message,
        time: now.toLocaleTimeString()
    });
    if (events.length > EVENT_LIMIT) {
        events.length = EVENT_LIMIT;
    }
    renderTerminal();
}

function renderTerminal() {
    const terminal = document.getElementById('tv-terminal');
    if (!terminal) return;

    if (events.length === 0) {
        terminal.innerHTML = '<div class="tv-log-line"><span class="tv-log-time">[--:--:--]</span>Awaiting telemetry...</div>';
        return;
    }

    terminal.innerHTML = events.map(event => {
        const tone = event.level === 'error'
            ? '#fca5a5'
            : event.level === 'warn'
                ? '#fcd34d'
                : event.level === 'info'
                    ? '#93c5fd'
                    : '#a7f3d0';
        return `<div class="tv-log-line" style="color:${tone}"><span class="tv-log-time">[${event.time}]</span>${event.message}</div>`;
    }).join('');
}

function formatClock(value) {
    return value.toLocaleTimeString([], {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function tickCommandPanels() {
    const now = new Date();
    const localClock = document.getElementById('tv-clock-local');
    const utcClock = document.getElementById('tv-clock-utc');
    const countdown = document.getElementById('tv-refresh-countdown');

    if (localClock) localClock.textContent = formatClock(now);
    if (utcClock) {
        const utcText = now.toLocaleTimeString([], {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZone: 'UTC'
        });
        utcClock.textContent = utcText;
    }

    if (countdown) {
        const secondsLeft = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
        countdown.textContent = `${secondsLeft}s`;
    }
}

function setModeChip(mode) {
    const chip = document.getElementById('tv-mode-chip');
    if (!chip) return;

    chip.classList.remove('tv-chip-global', 'tv-chip-failover', 'tv-chip-local');
    if (mode === 'local-only') {
        chip.textContent = 'LOCAL ONLY';
        chip.classList.add('tv-chip-local');
        return;
    }

    if (mode === 'failover') {
        chip.textContent = 'FAILOVER';
        chip.classList.add('tv-chip-failover');
        return;
    }

    chip.textContent = 'GLOBAL';
    chip.classList.add('tv-chip-global');
}

function attachFullscreenControls() {
    const button = document.getElementById('tv-fullscreen-btn');
    if (button) {
        button.addEventListener('click', async () => {
            try {
                if (document.fullscreenElement) {
                    await document.exitFullscreen();
                } else {
                    await document.documentElement.requestFullscreen();
                }
            } catch {
                pushEvent('warn', 'Fullscreen request was blocked by the browser.');
            }
        });
    }

    document.addEventListener('keydown', async (event) => {
        if (event.key.toLowerCase() !== 'f') return;
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else {
                await document.documentElement.requestFullscreen();
            }
        } catch {
            pushEvent('warn', 'Fullscreen toggle failed.');
        }
    });
}

function formatRelativeTime(isoTimestamp) {
    if (!isoTimestamp) return '—';
    const timestamp = new Date(isoTimestamp).getTime();
    if (Number.isNaN(timestamp)) return '—';

    const elapsedSeconds = Math.floor(Math.max(0, Date.now() - timestamp) / 1000);
    if (elapsedSeconds < 5) return 'just now';
    if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return `${elapsedHours}h ago`;

    const elapsedDays = Math.floor(elapsedHours / 24);
    return `${elapsedDays}d ago`;
}

function classifyService(service) {
    const status = service.status || 'Pending';
    const uptime = Number(service.uptime_24h);

    if (status === 'Down') return 'down';
    if (status === 'Pending') return 'degraded';
    if (status === 'Up' && Number.isFinite(uptime) && uptime < 99.9) return 'degraded';
    return 'up';
}

function severityRank(service) {
    const state = classifyService(service);
    if (state === 'down') return 0;
    if (state === 'degraded') return 1;
    return 2;
}

function formatSource(source) {
    if (source === 'local') return 'Local';
    if (source === 'globalping') return 'Globalping';
    return 'Unknown';
}

function sortServices(services) {
    return [...services].sort((a, b) => {
        const rankDelta = severityRank(a) - severityRank(b);
        if (rankDelta !== 0) return rankDelta;

        const aUptime = Number.isFinite(Number(a.uptime_24h)) ? Number(a.uptime_24h) : 100;
        const bUptime = Number.isFinite(Number(b.uptime_24h)) ? Number(b.uptime_24h) : 100;
        if (aUptime !== bUptime) return aUptime - bUptime;

        return String(a.name || '').localeCompare(String(b.name || ''));
    });
}

function renderWarning(meta) {
    const warning = document.getElementById('tv-warning');
    if (!warning) return;

    if (!meta || !meta.warning) {
        warning.textContent = '';
        warning.classList.add('hidden');
        return;
    }

    const modeLabel = meta.mode === 'local-only' ? 'LOCAL ONLY MODE' : 'FAILOVER MODE';
    warning.textContent = `${modeLabel}: ${meta.message || 'Global monitoring degraded. Checks running locally.'}`;
    warning.classList.remove('hidden');
}

function renderMode(meta) {
    const mode = meta?.mode || 'global';
    setModeChip(mode);

    if (mode !== lastMode) {
        if (mode === 'global') {
            pushEvent('ok', 'Global probe network restored. Returning to normal mode.');
        } else if (mode === 'failover') {
            pushEvent('warn', 'Global probe failures detected. Entered failover mode.');
        } else {
            pushEvent('warn', 'Forced local-only mode is active.');
        }
        lastMode = mode;
    }
}

function renderSummary(services) {
    const summary = document.getElementById('tv-summary');
    if (!summary) return;

    const aggregate = services.reduce((acc, service) => {
        const state = classifyService(service);
        acc.total += 1;
        if (state === 'up') acc.up += 1;
        if (state === 'degraded') acc.degraded += 1;
        if (state === 'down') acc.down += 1;

        if (service.lastChecked) {
            const t = new Date(service.lastChecked).getTime();
            if (Number.isFinite(t) && t > acc.lastCheckedAt) acc.lastCheckedAt = t;
        }

        return acc;
    }, { total: 0, up: 0, degraded: 0, down: 0, lastCheckedAt: 0 });

    const lastCheck = aggregate.lastCheckedAt > 0 ? formatRelativeTime(new Date(aggregate.lastCheckedAt).toISOString()) : '—';

    summary.innerHTML = `
        <div class="tv-summary-tile"><div class="tv-summary-label">Total</div><div class="tv-summary-value">${aggregate.total}</div></div>
        <div class="tv-summary-tile"><div class="tv-summary-label">Up</div><div class="tv-summary-value text-emerald-400">${aggregate.up}</div></div>
        <div class="tv-summary-tile"><div class="tv-summary-label">Degraded</div><div class="tv-summary-value text-amber-300">${aggregate.degraded}</div></div>
        <div class="tv-summary-tile"><div class="tv-summary-label">Down</div><div class="tv-summary-value text-rose-400">${aggregate.down}</div></div>
        <div class="tv-summary-tile"><div class="tv-summary-label">Last Check</div><div class="tv-summary-value text-xl">${lastCheck}</div></div>
    `;
}

function renderServices(services) {
    const content = document.getElementById('tv-content');
    if (!content) return;

    if (!services.length) {
        content.innerHTML = `
            <div class="tv-panel p-6 text-center col-span-full">
                <p class="text-slate-200 font-semibold text-xl">No services configured</p>
                <p class="tv-muted mt-2">Add services from the main dashboard to populate TV mode.</p>
            </div>
        `;
        return;
    }

    content.innerHTML = services.map(service => {
        const state = classifyService(service);
        const stateTone = state === 'down'
            ? 'text-rose-400'
            : state === 'degraded'
                ? 'text-amber-300'
                : 'text-emerald-400';
        const cardClass = state === 'down'
            ? 'tv-card-down'
            : state === 'degraded'
                ? 'tv-card-degraded'
                : 'tv-card-up';

        const uptime = service.uptime_24h != null ? `${service.uptime_24h}%` : '—';
        const source = formatSource(service.last_check_source);
        const lastChecked = formatRelativeTime(service.lastChecked);

        return `
            <article class="tv-card ${cardClass}">
                <div class="flex justify-between items-start gap-3">
                    <div>
                        <h2 class="tv-big text-slate-100">${service.name || 'Unnamed service'}</h2>
                        <p class="tv-muted mt-1 truncate">${service.target || ''}</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xl font-bold ${stateTone}">${service.status || 'Pending'}</p>
                        <p class="tv-muted mt-1">${service.lastResponseTime ?? '—'} ms</p>
                    </div>
                </div>
                <div class="grid grid-cols-3 gap-2 mt-4">
                    <div>
                        <p class="tv-muted">24h Uptime</p>
                        <p class="text-lg font-bold text-slate-100">${uptime}</p>
                    </div>
                    <div>
                        <p class="tv-muted">Source</p>
                        <p class="text-lg font-bold text-sky-300">${source}</p>
                    </div>
                    <div>
                        <p class="tv-muted">Last Check</p>
                        <p class="text-lg font-bold text-slate-100">${lastChecked}</p>
                    </div>
                </div>
            </article>
        `;
    }).join('');

    services.forEach(service => {
        const previous = previousSnapshots.get(service.id);
        if (!previous) {
            previousSnapshots.set(service.id, {
                status: service.status,
                source: service.last_check_source
            });
            return;
        }

        if (previous.status !== service.status) {
            const tone = service.status === 'Down' ? 'error' : service.status === 'Up' ? 'ok' : 'warn';
            pushEvent(tone, `${service.name}: status changed ${previous.status || 'Pending'} -> ${service.status || 'Pending'}`);
        }

        if (previous.source !== service.last_check_source) {
            pushEvent('info', `${service.name}: check source switched to ${formatSource(service.last_check_source).toUpperCase()}`);
        }

        previousSnapshots.set(service.id, {
            status: service.status,
            source: service.last_check_source
        });
    });
}

function renderError(message) {
    const content = document.getElementById('tv-content');
    if (!content) return;

    content.innerHTML = `
        <div class="tv-error rounded-xl p-6 col-span-full text-center">
            <p class="font-bold text-xl">TV mode could not load data</p>
            <p class="mt-2 text-sm">${message || 'Unknown error'}</p>
            <p class="mt-2 text-sm">If this is an auth issue, sign in from the main dashboard first.</p>
        </div>
    `;

    pushEvent('error', `Data refresh failed: ${message || 'unknown error'}`);
}

async function loadTvData() {
    try {
        const [servicesRaw, monitorMeta] = await Promise.all([
            apiFetch('/api/services'),
            apiFetch('/api/services/meta/monitoring')
        ]);

        const services = sortServices(Array.isArray(servicesRaw) ? servicesRaw : []);
        renderMode(monitorMeta);
        renderWarning(monitorMeta);
        renderSummary(services);
        renderServices(services);

        nextRefreshAt = Date.now() + REFRESH_MS;
        tickCommandPanels();

        const subtitle = document.getElementById('tv-subtitle');
        if (subtitle) {
            subtitle.textContent = `Read-only live dashboard • Updated ${new Date().toLocaleTimeString()}`;
        }

        const stateLabel = document.getElementById('tv-terminal-state');
        if (stateLabel) {
            stateLabel.textContent = monitorMeta?.warning ? 'DEGRADED' : 'ONLINE';
            stateLabel.style.color = monitorMeta?.warning ? '#fcd34d' : '#6ee7b7';
        }

        pushEvent('info', `Refresh complete: ${services.length} services processed.`);
    } catch (error) {
        const stateLabel = document.getElementById('tv-terminal-state');
        if (stateLabel) {
            stateLabel.textContent = 'ERROR';
            stateLabel.style.color = '#fca5a5';
        }
        renderWarning(null);
        renderMode({ mode: 'global' });
        renderSummary([]);
        renderError(error.message);
        nextRefreshAt = Date.now() + REFRESH_MS;
        tickCommandPanels();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (!localStorage.getItem('accessToken')) {
        window.location.href = '/';
        return;
    }

    pushEvent('ok', 'Command center online. Awaiting telemetry sync.');
    attachFullscreenControls();
    nextRefreshAt = Date.now() + REFRESH_MS;
    tickCommandPanels();

    loadTvData();
    refreshTimer = setInterval(loadTvData, REFRESH_MS);
    clockTimer = setInterval(tickCommandPanels, 1000);

    window.addEventListener('beforeunload', () => {
        if (refreshTimer) clearInterval(refreshTimer);
        if (clockTimer) clearInterval(clockTimer);
    });
});
