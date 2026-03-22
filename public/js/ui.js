// public/js/ui.js

import { apiFetch } from './api.js';
import { ensureWorldDotMap } from './worldDotMap.js';

// --- DOM Elements & State ---
const views = {
    auth: document.getElementById('auth-view'),
    dashboard: document.getElementById('dashboard-view'),
    manage: document.getElementById('manage-service-view'),
    settings: document.getElementById('settings-view'),
    tools: document.getElementById('tools-view')
};

const allLocations = {
    "Europe": [
        { code: "DE", name: "Germany" }, { code: "GB", name: "United Kingdom" }, 
        { code: "FR", name: "France" }, { code: "NL", name: "Netherlands" }
    ], 
    "North America": [
        { code: "US", name: "United States" }, { code: "CA", name: "Canada" }, 
        { code: "MX", name: "Mexico" }
    ],
    "Asia": [
        { code: "JP", name: "Japan" }, { code: "SG", name: "Singapore" }, 
        { code: "IN", name: "India" }
    ], 
    "South America": [
        { code: "BR", name: "Brazil" }
    ], 
    "Africa": [
        { code: "ZA", name: "South Africa" }
    ], 
    "Oceania": [
        { code: "AU", name: "Australia" }
    ],
    "Local": [
        { code: "LOCAL", name: "This Server", type: "local" }
    ]
};

const uptimeCharts = {};
let servicesCache = [];
let multiSelectInitialized = false;
let regionMapInstance = null;
let settingsRefreshInterval = null;
let activeViewName = 'auth';

const regionCoordinates = {
    US: { lat: 39.8, lon: -98.6 },
    CA: { lat: 56.1, lon: -106.3 },
    MX: { lat: 23.6, lon: -102.5 },
    BR: { lat: -14.2, lon: -51.9 },
    GB: { lat: 55.3, lon: -3.4 },
    FR: { lat: 46.2, lon: 2.2 },
    DE: { lat: 51.2, lon: 10.4 },
    NL: { lat: 52.1, lon: 5.3 },
    ZA: { lat: -30.6, lon: 22.9 },
    IN: { lat: 20.6, lon: 78.9 },
    SG: { lat: 1.3, lon: 103.8 },
    JP: { lat: 36.2, lon: 138.3 },
    AU: { lat: -25.3, lon: 133.8 }
};

function formatRelativeTime(isoTimestamp) {
    if (!isoTimestamp) return '—';
    const timestamp = new Date(isoTimestamp).getTime();
    if (Number.isNaN(timestamp)) return '—';

    const elapsedMs = Math.max(0, Date.now() - timestamp);
    const totalSeconds = Math.floor(elapsedMs / 1000);
    if (totalSeconds < 5) return 'just now';
    if (totalSeconds < 60) return `${totalSeconds}s ago`;

    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}m ago`;

    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 24) return `${totalHours}h ago`;

    const totalDays = Math.floor(totalHours / 24);
    return `${totalDays}d ago`;
}

function classifyServiceHealth(service) {
    const status = service.status || 'Pending';
    const uptime = Number(service.uptime_24h);

    if (status === 'Down') return 'down';
    if (service.is_degraded) return 'degraded';
    if (status === 'Pending') return 'degraded';
    if (status === 'Up' && Number.isFinite(uptime) && uptime < 99.9) return 'degraded';
    if (status === 'Up') return 'up';
    return 'degraded';
}

function getSeverityWeight(service) {
    const classification = classifyServiceHealth(service);
    if (classification === 'down') return 0;
    if (classification === 'degraded') return 1;
    return 2;
}

function sortServicesByPriority(services) {
    return [...services].sort((left, right) => {
        const severityDelta = getSeverityWeight(left) - getSeverityWeight(right);
        if (severityDelta !== 0) return severityDelta;

        const leftUptime = Number.isFinite(Number(left.uptime_24h)) ? Number(left.uptime_24h) : 100;
        const rightUptime = Number.isFinite(Number(right.uptime_24h)) ? Number(right.uptime_24h) : 100;
        if (leftUptime !== rightUptime) return leftUptime - rightUptime;

        return String(left.name || '').localeCompare(String(right.name || ''));
    });
}

function renderSummaryStrip(services) {
    const summaryContainer = document.getElementById('dashboard-summary');
    if (!summaryContainer) return;

    const summary = services.reduce((accumulator, service) => {
        const classification = classifyServiceHealth(service);
        accumulator.total += 1;
        if (classification === 'up') accumulator.up += 1;
        if (classification === 'down') accumulator.down += 1;
        if (classification === 'degraded') accumulator.degraded += 1;

        if (service.lastChecked) {
            const checkedAt = new Date(service.lastChecked).getTime();
            if (Number.isFinite(checkedAt) && checkedAt > accumulator.lastCheckedAt) {
                accumulator.lastCheckedAt = checkedAt;
            }
        }
        return accumulator;
    }, { total: 0, up: 0, down: 0, degraded: 0, lastCheckedAt: 0 });

    const lastCheckText = summary.lastCheckedAt > 0
        ? formatRelativeTime(new Date(summary.lastCheckedAt).toISOString())
        : '—';

    summaryContainer.innerHTML = `
        <div class="summary-tile"><div class="summary-label">Total</div><div class="summary-value">${summary.total}</div></div>
        <div class="summary-tile"><div class="summary-label">Up</div><div class="summary-value text-emerald-400">${summary.up}</div></div>
        <div class="summary-tile"><div class="summary-label">Degraded</div><div class="summary-value text-amber-300">${summary.degraded}</div></div>
        <div class="summary-tile"><div class="summary-label">Down</div><div class="summary-value text-rose-400">${summary.down}</div></div>
        <div class="summary-tile"><div class="summary-label">Last Check</div><div class="summary-value text-lg">${lastCheckText}</div></div>
    `;
}

function renderLoadingState(container) {
    container.innerHTML = `
        <div class="col-span-full grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 animate-pulse">
            <div class="glass p-6 h-44"></div>
            <div class="glass p-6 h-44"></div>
            <div class="glass p-6 h-44"></div>
        </div>
    `;
}

function renderEmptyState(container) {
    container.innerHTML = `
        <div class="col-span-full text-center text-slate-400 glass p-10">
            <p class="text-base text-slate-300">No services yet.</p>
            <p class="text-sm mt-1">Click <span class="text-slate-200 font-semibold">Add New Service</span> to start monitoring.</p>
        </div>
    `;
}

function renderErrorState(container, message) {
    container.innerHTML = `
        <div class="col-span-full glass p-8 text-center">
            <p class="text-rose-300 font-semibold">Could not load services.</p>
            <p class="text-slate-400 text-sm mt-1">${message || 'Please try again.'}</p>
            <button id="retry-load-services" class="mt-4 px-4 py-2 rounded-md btn-primary text-white font-semibold hover:opacity-90 transition">Retry</button>
        </div>
    `;
}

function formatCheckSource(source) {
    if (source === 'local') return 'Local';
    if (source === 'globalping') return 'Globalping';
    return 'Unknown';
}

function formatDurationSince(isoTimestamp) {
    if (!isoTimestamp) return null;
    const startedAt = new Date(isoTimestamp).getTime();
    if (Number.isNaN(startedAt)) return null;

    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const totalMinutes = Math.floor(elapsedMs / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function formatPercent(value) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return '—';
    return `${numberValue.toFixed(2)}%`;
}

function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const scaled = value / (1024 ** exponent);
    return `${scaled.toFixed(scaled >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatUptimeSeconds(seconds) {
    const totalSeconds = Number(seconds);
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function formatEventStatus(event) {
    if (event.status === 0) return 'DOWN';
    if (event.is_degraded) return 'DEGRADED';
    return 'UP';
}

function getCoordinatesForRegion(region) {
    if (region.location_code === 'LOCAL') {
        return { lat: 0, lon: 0 };
    }

    const code = String(region.location_code || '').toUpperCase();
    const known = regionCoordinates[code];
    if (known) {
        return { lat: known.lat, lon: known.lon };
    }

    const fallback = String(region.location_label || 'UNKNOWN');
    let hash = 0;
    for (let index = 0; index < fallback.length; index += 1) {
        hash = ((hash << 5) - hash) + fallback.charCodeAt(index);
        hash |= 0;
    }

    return {
        lat: -50 + (Math.abs(hash) % 100),
        lon: -170 + (Math.abs(hash * 7) % 340)
    };
}

function getMarkerColor(region) {
    if (region.status === 0) return '#ff4da6';
    if (region.is_degraded) return '#ffe066';
    return '#2de2e6';
}

async function renderRegionalSnapshot(serviceId) {
    const mapElement = document.getElementById('modal-region-map');
    const tooltipElement = document.getElementById('modal-region-tooltip');
    const listElement = document.getElementById('modal-region-list');

    if (!mapElement || !tooltipElement || !listElement) return;

    listElement.innerHTML = '<li>Loading regional data...</li>';
    tooltipElement.textContent = 'Loading regional data...';

    regionMapInstance = regionMapInstance || await ensureWorldDotMap(mapElement);
    if (!regionMapInstance) {
        listElement.innerHTML = '<li>Map library is unavailable.</li>';
        tooltipElement.textContent = 'Map library is unavailable.';
        return;
    }
    regionMapInstance.setPoints([]);

    try {
        const payload = await apiFetch(`/api/services/${serviceId}/regions/latest`);
        const regions = Array.isArray(payload?.regions) ? payload.regions : [];
        listElement.innerHTML = '';

        if (regions.length === 0) {
            listElement.innerHTML = '<li>No regional snapshot available yet.</li>';
            tooltipElement.textContent = 'No regional snapshot available yet.';
            return;
        }

        const points = [];

        regions.forEach(region => {
            const coordinates = getCoordinatesForRegion(region);

            const latencyText = `${region.response_time ?? 'N/A'}ms`;
            const sourceText = String(region.check_source || 'unknown').toUpperCase();
            const reasonText = region.reason ? ` • ${region.reason}` : '';
            const details = `${region.location_label} • ${latencyText} • ${sourceText}${reasonText}`;

            points.push({
                lat: coordinates.lat,
                lon: coordinates.lon,
                color: getMarkerColor(region),
                label: details,
                details
            });

            const listItem = document.createElement('li');
            const stateText = region.status === 0 ? 'DOWN' : 'UP';
            listItem.className = region.status === 0 ? 'text-rose-300' : 'text-emerald-300';
            listItem.textContent = `${region.location_label} • ${latencyText} • ${stateText} • ${sourceText}`;
            listElement.appendChild(listItem);
        });

        regionMapInstance.setPoints(points, {
            onHover: (point) => {
                tooltipElement.textContent = point.details;
            },
            onClick: (point) => {
                tooltipElement.textContent = point.details;
            }
        });

        const first = regions[0];
        tooltipElement.textContent = `${first.location_label} • ${first.response_time ?? 'N/A'}ms • ${String(first.check_source || 'unknown').toUpperCase()}`;
    } catch {
        listElement.innerHTML = '<li>Could not load regional snapshot.</li>';
        tooltipElement.textContent = 'Could not load regional snapshot.';
    }
}

export function switchModalTab(tabName) {
    const overviewTab = document.getElementById('modal-tab-overview');
    const diagnosticsTab = document.getElementById('modal-tab-diagnostics');
    const overviewPanel = document.getElementById('modal-panel-overview');
    const diagnosticsPanel = document.getElementById('modal-panel-diagnostics');

    if (!overviewTab || !diagnosticsTab || !overviewPanel || !diagnosticsPanel) return;

    const showOverview = tabName !== 'diagnostics';

    overviewTab.classList.toggle('active', showOverview);
    diagnosticsTab.classList.toggle('active', !showOverview);
    overviewPanel.classList.toggle('hidden', !showOverview);
    diagnosticsPanel.classList.toggle('hidden', showOverview);

}

// --- Navigation & Core UI ---
export function navigate(viewName) {
    const leavingToolsView = activeViewName === 'tools' && viewName !== 'tools';
    if (leavingToolsView) {
        window.dispatchEvent(new CustomEvent('tools-view-leave'));
    }

    // Always close the detail modal when navigating to prevent overlay blocking clicks
    const modal = document.getElementById('detail-modal');
    if (modal) modal.classList.remove('visible');

    Object.values(views).forEach(v => v.classList.add('hidden'));
    views[viewName].classList.remove('hidden');
    activeViewName = viewName;

    if (viewName !== 'settings' && settingsRefreshInterval) {
        clearInterval(settingsRefreshInterval);
        settingsRefreshInterval = null;
    }
}

async function refreshSettingsData() {
    const emailLabel = document.getElementById('settings-current-email');
    const usageFill = document.getElementById('globalping-usage-fill');
    const usageUsed = document.getElementById('globalping-usage-used');
    const usageLimit = document.getElementById('globalping-usage-limit');
    const usageNote = document.getElementById('globalping-usage-note');
    const runtimeCpuUsage = document.getElementById('runtime-cpu-usage');
    const runtimeMemoryUsage = document.getElementById('runtime-memory-usage');
    const runtimeDiskUsage = document.getElementById('runtime-disk-usage');
    const runtimeNodeVersion = document.getElementById('runtime-node-version');
    const runtimeNodeUptime = document.getElementById('runtime-node-uptime');
    const runtimePlatform = document.getElementById('runtime-platform');
    const runtimeRefreshed = document.getElementById('runtime-refreshed');
    const refreshStatus = document.getElementById('settings-auto-refresh-status');

    if (!emailLabel || !usageFill || !usageUsed || !usageLimit || !usageNote) return;

    emailLabel.textContent = 'Loading account settings...';
    usageUsed.textContent = '0';
    usageLimit.textContent = '0';
    usageFill.style.width = '0%';
    usageNote.textContent = '';
    if (runtimeCpuUsage) runtimeCpuUsage.textContent = '—';
    if (runtimeMemoryUsage) runtimeMemoryUsage.textContent = '—';
    if (runtimeDiskUsage) runtimeDiskUsage.textContent = '—';
    if (runtimeNodeVersion) runtimeNodeVersion.textContent = 'Node: -';
    if (runtimeNodeUptime) runtimeNodeUptime.textContent = 'Process uptime: -';
    if (runtimePlatform) runtimePlatform.textContent = 'Platform: -';
    if (runtimeRefreshed) runtimeRefreshed.textContent = 'Last updated: -';
    if (refreshStatus) refreshStatus.textContent = 'Auto-refresh every 15s • updating...';

    try {
        const account = await apiFetch('/api/account');
        const usage = account?.globalpingUsage || {};
        const used = Number(usage.used || 0);
        const limit = Number(usage.limit || 0);
        const usagePercent = Number(usage.usagePercent || 0);

        emailLabel.textContent = `Signed in as ${account?.email || 'unknown'}`;
        usageUsed.textContent = `${used.toLocaleString()} checks used`;
        usageLimit.textContent = `${limit.toLocaleString()} limit`;
        usageFill.style.width = `${Math.max(0, Math.min(100, usagePercent))}%`;
        usageNote.textContent = usage.estimated
            ? 'Estimated usage from stored Globalping check history for this month.'
            : 'Usage data provided by Globalping.';

        const runtime = account?.runtimeStats;
        if (runtimeCpuUsage) {
            runtimeCpuUsage.textContent = formatPercent(runtime?.system?.cpuUsagePercent);
        }
        if (runtimeMemoryUsage) {
            runtimeMemoryUsage.textContent = formatPercent(runtime?.system?.memory?.usagePercent);
        }
        if (runtimeDiskUsage) {
            const disk = runtime?.system?.disk;
            runtimeDiskUsage.textContent = disk?.unavailable
                ? 'Unavailable'
                : formatPercent(disk?.usagePercent);
        }
        if (runtimeNodeVersion) {
            runtimeNodeVersion.textContent = `Node: ${runtime?.node?.version || '-'}`;
        }
        if (runtimeNodeUptime) {
            runtimeNodeUptime.textContent = `Process uptime: ${formatUptimeSeconds(runtime?.node?.uptimeSeconds)}`;
        }
        if (runtimePlatform) {
            const platform = runtime?.system?.platform || '-';
            const memoryUsed = formatBytes(runtime?.system?.memory?.usedBytes);
            const memoryTotal = formatBytes(runtime?.system?.memory?.totalBytes);
            const diskMount = runtime?.system?.disk?.mount || '/';
            runtimePlatform.textContent = `Platform: ${platform} • RAM ${memoryUsed} / ${memoryTotal} • Disk ${diskMount}`;
        }
        if (runtimeRefreshed) {
            runtimeRefreshed.textContent = `Last updated: ${runtime?.generatedAt ? new Date(runtime.generatedAt).toLocaleString() : '-'}`;
        }
        if (refreshStatus) {
            const refreshedAt = runtime?.generatedAt || new Date().toISOString();
            refreshStatus.textContent = `Auto-refresh every 15s • last update ${formatRelativeTime(refreshedAt)}`;
        }

        const emailInput = document.getElementById('settings-email');
        if (emailInput) {
            emailInput.value = account?.email || '';
        }
    } catch (error) {
        emailLabel.textContent = 'Could not load account settings.';
        usageNote.textContent = error.message || 'Please try again.';
        if (refreshStatus) {
            refreshStatus.textContent = 'Auto-refresh every 15s • latest update failed';
        }
    }
}

export async function showSettingsPage() {
    navigate('settings');
    await refreshSettingsData();
    await loadWebhooks();

    if (settingsRefreshInterval) {
        clearInterval(settingsRefreshInterval);
        settingsRefreshInterval = null;
    }

    settingsRefreshInterval = setInterval(() => {
        refreshSettingsData();
    }, 15000);
}

export function showToolsPage() {
    navigate('tools');
}

export async function loadServices() {
    const container = document.getElementById('services-container');
    renderDashboardHealth(null, { loading: true });

    // Add refreshing animation before fetching data
    document.querySelectorAll('.service-card').forEach(card => {
        card.classList.remove('status-up', 'status-down', 'status-pending');
        card.classList.add('status-refreshing');
    });

    if (container && servicesCache.length === 0) {
        renderLoadingState(container);
    }

    try {
        const [servicesResponse, monitoringResponse, healthResponse] = await Promise.all([
            apiFetch('/api/services'),
            apiFetch('/api/services/meta/monitoring'),
            apiFetch('/api/health').catch(() => null)
        ]);
        servicesCache = sortServicesByPriority(servicesResponse);
        renderMonitoringWarning(monitoringResponse);
        renderDashboardHealth(healthResponse);
        renderSummaryStrip(servicesCache);
        container.innerHTML = '';
        if (servicesCache.length === 0) {
            renderEmptyState(container);
            return;
        }
        servicesCache.forEach(renderServiceCard);
    } catch (error) {
        renderMonitoringWarning(null);
        renderDashboardHealth(null);
        renderSummaryStrip([]);
        if (container) {
            renderErrorState(container, error.message);
        }
        console.error(error.message);
    }
}

function renderDashboardHealth(healthPayload, options = {}) {
    const chip = document.getElementById('dashboard-health-chip');
    if (!chip) return;

    const loading = Boolean(options.loading);
    chip.classList.remove('up', 'down', 'loading');

    if (loading) {
        chip.classList.add('loading');
        chip.textContent = 'Checking';
        return;
    }

    if (!healthPayload) {
        chip.classList.add('down');
        chip.textContent = 'Unavailable';
        return;
    }

    const monitoringMode = String(healthPayload?.monitoring?.mode || 'global');
    const healthy = Boolean(healthPayload?.ok) && healthPayload?.database === 'up';
    const modeSuffix = monitoringMode === 'global'
        ? ''
        : monitoringMode === 'local-only'
            ? ' • Local'
            : ' • Failover';

    chip.classList.add(healthy ? 'up' : 'down');
    chip.textContent = `${healthy ? 'Healthy' : 'Degraded'}${modeSuffix}`;
}

function renderMonitoringWarning(meta) {
    const warning = document.getElementById('monitoring-warning');
    if (!warning) return;

    if (!meta || !meta.warning) {
        warning.classList.add('hidden');
        warning.textContent = '';
        return;
    }

    const modeLabel = meta.mode === 'local-only' ? 'LOCAL ONLY MODE' : 'FAILOVER MODE';
    warning.textContent = `${modeLabel}: ${meta.message || 'Global monitoring is degraded. Running checks locally.'}`;
    warning.classList.remove('hidden');
}

function renderServiceCard(service) {
    const container = document.getElementById('services-container');
    const status = service.status || 'Pending';
    const statusClass = `status-${status.toLowerCase()}`;
    const checkSource = formatCheckSource(service.last_check_source);
    const activeIncidentDuration = formatDurationSince(service.active_incident_since);
    const statusTone = status === 'Up'
        ? 'text-emerald-400'
        : status === 'Down'
            ? 'text-rose-400'
            : 'text-amber-300';
    const uptime = service.uptime_24h != null ? `${service.uptime_24h}%` : '...';
    const uptimeColor = service.uptime_24h >= 99.9 ? 'text-green-400' : 'text-yellow-400';
    let locationsText = "None";
    try {
        const parsedLocations = JSON.parse(service.locations || '[]');
        if (Array.isArray(parsedLocations) && parsedLocations.length > 0) {
            locationsText = parsedLocations.map(l => l.value).join(', ');
        }
    } catch (e) {
        locationsText = "Invalid Locations";
    }

    // NEW: Create the outer div for clipping and animation
    const cardOuter = document.createElement('div');
    cardOuter.className = `service-card ${statusClass}`;
    cardOuter.dataset.serviceId = service.id;

    // Create the inner div for content
    const cardInner = document.createElement('div');
    cardInner.className = 'card-content flex flex-col';
    
    cardInner.innerHTML = `
        <div class="flex-grow flex flex-col">
            <div class="flex justify-between items-start mb-4">
                <div>
                    <h3 class="text-xl font-bold text-white">${service.name}</h3>
                    <p class="text-sm text-slate-400 truncate mt-0.5">${service.target}</p>
                </div>
                <div class="text-right">
                    <div class="font-semibold tracking-wide ${statusTone}">${status}</div>
                    <div class="text-xs text-slate-400 mt-1">${service.lastResponseTime ?? 'N/A'} ms</div>
                    <div class="text-xs text-slate-500 mt-1">${checkSource}</div>
                </div>
            </div>
            <div class="flex-grow flex items-end justify-between gap-4">
                <div class="flex-grow h-16">
                    <canvas id="sparkline-${service.id}"></canvas>
                </div>
                <div class="text-right">
                    <div class="text-xs text-slate-400">24h Uptime</div>
                    <div class="text-2xl font-bold ${uptimeColor}">${uptime}</div>
                </div>
            </div>
            ${status === 'Down' && activeIncidentDuration ? `<div class="mt-2 text-xs text-rose-300">Active incident: ${activeIncidentDuration}</div>` : ''}
        </div>
        <div class="mt-4 pt-4 border-t border-slate-700 flex items-center justify-between text-xs text-slate-400">
            <button data-id="${service.id}" class="edit-service-button font-semibold text-blue-400 hover:text-blue-300">Edit</button>
            <button data-id="${service.id}" class="delete-service-button font-semibold text-red-400 hover:text-red-300">Delete</button>
        </div>`;
    
    cardOuter.appendChild(cardInner);
    container.appendChild(cardOuter);
    renderSparkline(service.id);
}

// --- Charting ---
async function renderSparkline(serviceId) {
    try {
        const history = await apiFetch(`/api/services/${serviceId}/history`);
        if (history.length === 0) return;
        
        const data = history.map(h => h.response_time);
        const labels = history.map(() => '');
        const ctx = document.getElementById(`sparkline-${serviceId}`).getContext('2d');

        new Chart(ctx, {
            type: 'line',
            data: { labels, datasets: [{ data, borderColor: '#60a5fa', borderWidth: 2, pointRadius: 0, tension: 0.4 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { x: { display: false }, y: { display: false } },
                plugins: { legend: { display: false }, tooltip: { enabled: false } }
            }
        });
    } catch (e) { /* fail silently */ }
}

// --- Detail Modal Logic ---
export function openDetailModal(serviceId) {
    const service = servicesCache.find(s => s.id == serviceId);
    if (!service) return;

    const modal = document.getElementById('detail-modal');
    document.getElementById('modal-title').textContent = service.name;
    document.getElementById('modal-target').textContent = service.target;
    document.getElementById('modal-uptime').textContent = `${service.uptime_24h ?? '...'}%`;
    document.getElementById('modal-check-source').textContent = formatCheckSource(service.last_check_source);

    const incidentStatusElement = document.getElementById('modal-incident-status');
    const incidentReasonElement = document.getElementById('modal-last-incident-reason');
    const degradationStatusElement = document.getElementById('modal-degradation-status');
    const degradationReasonElement = document.getElementById('modal-last-degradation-reason');
    const activeIncidentDuration = formatDurationSince(service.active_incident_since);
    const activeDegradationDuration = formatDurationSince(service.active_degradation_since);
    if (service.status === 'Down' && activeIncidentDuration) {
        incidentStatusElement.textContent = `Active incident for ${activeIncidentDuration}`;
        incidentStatusElement.className = 'text-sm text-rose-300';
    } else {
        incidentStatusElement.textContent = 'No active incident.';
        incidentStatusElement.className = 'text-sm text-slate-300';
    }

    if (service.last_incident_reason) {
        incidentReasonElement.textContent = `Last reason: ${service.last_incident_reason}`;
    } else {
        incidentReasonElement.textContent = '';
    }

    if (service.is_degraded && activeDegradationDuration) {
        degradationStatusElement.textContent = `Active degradation for ${activeDegradationDuration}`;
        degradationStatusElement.className = 'text-sm text-amber-300';
    } else {
        degradationStatusElement.textContent = 'No active degradation.';
        degradationStatusElement.className = 'text-sm text-slate-300';
    }

    if (service.last_degradation_reason) {
        degradationReasonElement.textContent = `Last reason: ${service.last_degradation_reason}`;
    } else {
        degradationReasonElement.textContent = '';
    }
    
    const uptimeColor = service.uptime_24h >= 99.9 ? 'text-green-400' : 'text-yellow-400';
    document.getElementById('modal-uptime').className = `text-3xl font-bold ${uptimeColor}`;

    const downtimeList = document.getElementById('modal-downtime-list');
    const eventsList = document.getElementById('modal-events-list');
    const totalUptimeElement = document.getElementById('modal-total-uptime');
    const totalChecksElement = document.getElementById('modal-total-checks');
    const incidentsList = document.getElementById('modal-incidents-list');
    downtimeList.innerHTML = '<li>Loading...</li>';
    eventsList.innerHTML = '<li>Loading event log...</li>';
    totalUptimeElement.textContent = '-';
    totalChecksElement.textContent = '';
    document.getElementById('modal-uptime-7d').textContent = '-';
    document.getElementById('modal-uptime-30d').textContent = '-';
    document.getElementById('modal-uptime-365d').textContent = '-';
    document.getElementById('modal-uptime-alltime').textContent = '-';
    if (incidentsList) incidentsList.innerHTML = '<li>Loading...</li>';

    // Fill monitor config from service cache immediately
    const configType = document.getElementById('modal-config-type');
    const configInterval = document.getElementById('modal-config-interval');
    const configSince = document.getElementById('modal-config-since');
    if (configType) configType.textContent = (service.type || '-').toUpperCase();
    if (configInterval) {
        const secs = Math.round((service.interval || 0) / 1000);
        configInterval.textContent = secs >= 3600 ? `${(secs/3600).toFixed(1)}h` : secs >= 60 ? `${Math.round(secs/60)}m` : `${secs}s`;
    }
    if (configSince) configSince.textContent = '-';  // refined below once /details loads

    modal.classList.add('visible');
    switchModalTab('overview');
    renderRegionalSnapshot(serviceId);

    apiFetch(`/api/services/${serviceId}/details`).then(details => {
        const u = details?.uptime;
        if (!u) return;
        const fmtUptime = v => (typeof v === 'number' ? `${v.toFixed(2)}%` : '-');
        document.getElementById('modal-uptime-7d').textContent = fmtUptime(u.last7d);
        document.getElementById('modal-uptime-30d').textContent = fmtUptime(u.last30d);
        document.getElementById('modal-uptime-365d').textContent = fmtUptime(u.last365d);
        document.getElementById('modal-uptime-alltime').textContent = fmtUptime(u.total);
        const monitoredSince = details?.service?.monitoredSince;
        if (monitoredSince) {
            totalChecksElement.textContent = `Monitored since ${new Date(monitoredSince).toLocaleDateString()}`;
            if (configSince) configSince.textContent = new Date(monitoredSince).toLocaleDateString();
        }
    }).catch(() => {});

    apiFetch(`/api/services/${serviceId}/incidents`).then(data => {
        if (!incidentsList) return;
        incidentsList.innerHTML = '';
        if (!data?.incidents?.length) {
            incidentsList.innerHTML = '<li class="text-slate-500">No incidents recorded.</li>';
            return;
        }
        data.incidents.slice(0, 15).forEach(inc => {
            const li = document.createElement('li');
            const start = new Date(inc.started_at).toLocaleString();
            const dur = inc.duration_ms ? ` (${Math.round(inc.duration_ms / 60000)}m)` : ' (ongoing)';
            const reason = inc.reason ? ` — ${inc.reason}` : '';
            li.className = 'text-rose-300';
            li.textContent = `${start}${dur}${reason}`;
            incidentsList.appendChild(li);
        });
    }).catch(() => {
        if (incidentsList) incidentsList.innerHTML = '<li class="text-slate-500">Could not load incidents.</li>';
    });

    apiFetch(`/api/services/${serviceId}/history`).then(history => {
        const labels = history.map(h => new Date(h.timestamp).toLocaleTimeString());
        const data = history.map(h => h.response_time);
        const ctx = document.getElementById('modal-chart').getContext('2d');
        if (uptimeCharts.modal) uptimeCharts.modal.destroy();
        uptimeCharts.modal = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Response Time (ms)', data, borderColor: 'rgba(96, 165, 250, 1)', backgroundColor: 'rgba(96, 165, 250, 0.2)',
                    fill: true, tension: 0.4, pointBackgroundColor: 'rgba(96, 165, 250, 1)', pointRadius: 2,
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: true,
                scales: {
                    y: { beginAtZero: true, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148, 163, 184, 0.1)' } },
                    x: { ticks: { color: '#94a3b8' }, grid: { display: false } }
                },
                plugins: { legend: { display: false } }
            }
        });

        const downtimes = history.filter(h => h.status === 0);
        downtimeList.innerHTML = '';
        if (downtimes.length === 0) {
            downtimeList.innerHTML = '<li>No downtime in the last 30 checks.</li>';
        } else {
            downtimes.reverse().slice(0, 5).forEach(d => {
                const li = document.createElement('li');
                li.textContent = `Down at ${new Date(d.timestamp).toLocaleString()}`;
                downtimeList.appendChild(li);
            });
        }

    });

    apiFetch(`/api/services/${serviceId}/events`).then(events => {
        eventsList.innerHTML = '';
        if (!Array.isArray(events) || events.length === 0) {
            eventsList.innerHTML = '<li>No check events available.</li>';
            return;
        }

        events.slice(0, 20).forEach(event => {
            const li = document.createElement('li');
            const tone = event.status === 0
                ? 'text-rose-300'
                : event.is_degraded
                    ? 'text-amber-300'
                    : 'text-emerald-300';
            const timeoutSuffix = event.timed_out ? ' • timeout' : '';
            const reasonText = event.check_reason ? ` • ${event.check_reason}` : '';
            li.className = tone;
            li.textContent = `${new Date(event.timestamp).toLocaleString()} • ${formatEventStatus(event)} • ${event.response_time ?? 'N/A'}ms • ${(event.check_source || 'unknown').toUpperCase()}${timeoutSuffix}${reasonText}`;
            eventsList.appendChild(li);
        });
    }).catch(() => {
        eventsList.innerHTML = '<li>Could not load check events.</li>';
    });

    apiFetch(`/api/services/${serviceId}/rollups`).then(rollup => {
        const uptime = rollup?.totals?.uptime;
        const totalChecks = rollup?.totals?.totalChecks;
        totalUptimeElement.textContent = Number.isFinite(Number(uptime)) ? `${Number(uptime).toFixed(4)}%` : '-';
        if (!totalChecksElement.textContent) {
            totalChecksElement.textContent = Number.isFinite(Number(totalChecks)) ? `${totalChecks} retained daily checks` : '';
        }
    }).catch(() => {
        totalUptimeElement.textContent = '-';
        totalChecksElement.textContent = 'Rollup stats unavailable.';
    });
}

export function closeDetailModal() {
    document.getElementById('detail-modal').classList.remove('visible');
    if (uptimeCharts.modal) {
        uptimeCharts.modal.destroy();
    }
}

// --- Manage Service Page Logic ---
export function showManageServicePage(serviceId = null) {
    if (!multiSelectInitialized) {
        initializeMultiSelectListeners();
        multiSelectInitialized = true;
    }

    const service = serviceId ? servicesCache.find(s => s.id == serviceId) : null;
    const form = document.getElementById('manage-service-form');
    form.reset();
    document.getElementById('manage-service-title').textContent = service ? 'Edit Service' : 'Add New Service';
    document.getElementById('service-id').value = service ? service.id : '';
    if (service) {
        document.getElementById('service-name').value = service.name;
        document.getElementById('service-type').value = service.type;
        document.getElementById('service-target').value = service.target;
        document.getElementById('service-interval').value = service.interval / 1000;
    }
    const alertsCheckbox = document.getElementById('service-alerts-enabled');
    if (alertsCheckbox) alertsCheckbox.checked = Boolean(service?.alerts_enabled);
    populateMultiSelect(service ? JSON.parse(service.locations || '[]') : []);
    navigate('manage');
}

// --- Multi-Select Logic ---
function populateMultiSelect(selectedLocations) {
    const tagsContainer = document.getElementById('tags-container');
    const dropdown = document.getElementById('locations-dropdown');
    
    tagsContainer.innerHTML = '';
    dropdown.innerHTML = '';

    const allFlattenedLocations = Object.values(allLocations).flat();
    const selectedKeys = selectedLocations.map(loc => `${loc.value}|${loc.type || 'country'}`);

    selectedLocations.forEach(location => {
        const locationData = allFlattenedLocations.find(
            item => item.code === location.value && (item.type || 'country') === (location.type || 'country')
        );
        if (locationData) addTag(locationData);
    });

    for (const continent in allLocations) {
        const continentHeader = document.createElement('div');
        continentHeader.className = 'dropdown-header';
        continentHeader.textContent = continent;
        dropdown.appendChild(continentHeader);

        allLocations[continent].forEach(loc => {
            const locationKey = `${loc.code}|${loc.type || 'country'}`;
            if (!selectedKeys.includes(locationKey)) {
                dropdown.appendChild(createDropdownItem(loc));
            }
        });
    }
}

function addTag(locationData) {
    const tagsContainer = document.getElementById('tags-container');
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.dataset.code = locationData.code;
    tag.dataset.name = locationData.name;
    tag.dataset.type = locationData.type || 'country';
    tag.innerHTML = `<span>${locationData.name} (${locationData.code})</span><span class="tag-close">&times;</span>`;
    tagsContainer.appendChild(tag);
}

function createDropdownItem(locationData) {
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.dataset.code = locationData.code;
    item.dataset.name = locationData.name;
    item.dataset.type = locationData.type || 'country';
    item.textContent = `${locationData.name} (${locationData.code})`;
    return item;
}

function filterLocations() {
    const searchInput = document.getElementById('location-search');
    const dropdown = document.getElementById('locations-dropdown');
    const filter = searchInput.value.toLowerCase();
    dropdown.querySelectorAll('.dropdown-item, .dropdown-header').forEach(item => {
        const text = item.textContent.toLowerCase();
        item.classList.toggle('hidden', !text.includes(filter));
    });
}

function initializeMultiSelectListeners() {
    const container = document.getElementById('multi-select-container');
    const searchInput = document.getElementById('location-search');
    const dropdown = document.getElementById('locations-dropdown');
    const tagsContainer = document.getElementById('tags-container');

    searchInput.addEventListener('focus', () => dropdown.classList.remove('hidden'));
    searchInput.addEventListener('input', filterLocations);
    
    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });

    dropdown.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = e.target.closest('.dropdown-item');
        if (item) {
            const locationData = {
                code: item.dataset.code,
                name: item.dataset.name,
                type: item.dataset.type || 'country'
            };
            addTag(locationData);
            item.remove();
            searchInput.value = '';
            filterLocations();
            dropdown.classList.remove('hidden');
            searchInput.focus();
        }
    });

    tagsContainer.addEventListener('click', (e) => {
        if (e.target.classList.contains('tag-close')) {
            const tag = e.target.parentElement;
            const currentSelected = Array.from(tagsContainer.querySelectorAll('.tag'))
                .filter(t => t !== tag)
                .map(t => ({ value: t.dataset.code, type: t.dataset.type || 'country' }));
            populateMultiSelect(currentSelected);
            tag.remove();
        }
    });
}

// --- Webhook Management ---

export async function loadWebhooks() {
    const list = document.getElementById('webhooks-list');
    if (!list) return;
    list.innerHTML = '<p class="text-sm text-slate-500">Loading...</p>';
    try {
        const webhooks = await apiFetch('/api/webhooks');
        renderWebhooksList(webhooks);
    } catch {
        list.innerHTML = '<p class="text-sm text-rose-400">Could not load webhooks.</p>';
    }
}

function renderWebhooksList(webhooks) {
    const list = document.getElementById('webhooks-list');
    if (!list) return;
    list.innerHTML = '';
    if (!webhooks || webhooks.length === 0) {
        list.innerHTML = '<p class="text-sm text-slate-500">No webhooks configured. Add one above.</p>';
        return;
    }
    webhooks.forEach(webhook => {
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between gap-4 p-3 rounded-lg border border-slate-700 bg-slate-800/50';
        const eventsLabel = Array.isArray(webhook.events) ? webhook.events.map(e => e.replace('service.', '')).join(', ') : '—';
        const truncUrl = webhook.url.length > 50 ? webhook.url.slice(0, 50) + '…' : webhook.url;
        const activeDot = webhook.is_active
            ? '<span class="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-1"></span>'
            : '<span class="inline-block w-2 h-2 rounded-full bg-slate-500 mr-1"></span>';
        div.innerHTML = `
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">${activeDot}<span class="font-semibold text-slate-200 text-sm">${webhook.name}</span>${webhook.has_secret ? '<span class="text-xs text-slate-500">🔑 signed</span>' : ''}</div>
                <div class="text-xs text-slate-400 truncate mt-0.5">${truncUrl}</div>
                <div class="text-xs text-slate-500 mt-0.5">on: ${eventsLabel}</div>
            </div>
            <div class="flex gap-2 flex-shrink-0">
                <button data-webhook-id="${webhook.id}" class="webhook-test-btn text-xs py-1 px-2 rounded text-sky-400 hover:text-sky-300 border border-sky-800 hover:border-sky-600 transition">Test</button>
                <button data-webhook-id="${webhook.id}" class="webhook-edit-btn text-xs py-1 px-2 rounded text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 transition">Edit</button>
                <button data-webhook-id="${webhook.id}" class="webhook-delete-btn text-xs py-1 px-2 rounded text-rose-400 hover:text-rose-300 border border-rose-900 hover:border-rose-700 transition">Delete</button>
            </div>`;
        div.querySelector('.webhook-edit-btn').addEventListener('click', () => openWebhookForm(webhook));
        div.querySelector('.webhook-delete-btn').addEventListener('click', () => deleteWebhook(webhook.id));
        div.querySelector('.webhook-test-btn').addEventListener('click', () => testWebhook(webhook.id, div.querySelector('.webhook-test-btn')));
        list.appendChild(div);
    });
}

export function openWebhookForm(webhook = null) {
    const overlay = document.getElementById('webhook-form-overlay');
    const title = document.getElementById('webhook-form-title');
    const idInput = document.getElementById('webhook-id');
    const nameInput = document.getElementById('webhook-name');
    const urlInput = document.getElementById('webhook-url');
    const secretInput = document.getElementById('webhook-secret');
    const cbDown = document.getElementById('webhook-event-down');
    const cbRecovered = document.getElementById('webhook-event-recovered');
    const cbDegraded = document.getElementById('webhook-event-degraded');
    const cbActive = document.getElementById('webhook-active');
    const errDiv = document.getElementById('webhook-form-error');
    if (!overlay) return;

    document.getElementById('webhook-form')?.reset();
    if (errDiv) errDiv.classList.add('hidden');

    if (webhook) {
        title.textContent = 'Edit Webhook';
        idInput.value = webhook.id;
        nameInput.value = webhook.name;
        urlInput.value = webhook.url;
        secretInput.value = '';
        secretInput.placeholder = webhook.has_secret ? 'Leave blank to keep existing secret' : 'Leave blank to set none';
        const events = Array.isArray(webhook.events) ? webhook.events : [];
        if (cbDown) cbDown.checked = events.includes('service.down');
        if (cbRecovered) cbRecovered.checked = events.includes('service.recovered');
        if (cbDegraded) cbDegraded.checked = events.includes('service.degraded');
        if (cbActive) cbActive.checked = Boolean(webhook.is_active);
    } else {
        title.textContent = 'Add Webhook';
        idInput.value = '';
        secretInput.placeholder = 'Leave blank to set none';
        if (cbDown) cbDown.checked = true;
        if (cbRecovered) cbRecovered.checked = true;
        if (cbDegraded) cbDegraded.checked = false;
        if (cbActive) cbActive.checked = true;
    }
    overlay.classList.add('visible');
}

export function closeWebhookForm() {
    const overlay = document.getElementById('webhook-form-overlay');
    if (overlay) overlay.classList.remove('visible');
}

export async function handleWebhookFormSubmit(e) {
    e.preventDefault();
    const errDiv = document.getElementById('webhook-form-error');
    if (errDiv) errDiv.classList.add('hidden');
    const id = document.getElementById('webhook-id').value;
    const name = document.getElementById('webhook-name').value;
    const url = document.getElementById('webhook-url').value;
    const secretRaw = document.getElementById('webhook-secret').value;
    const isEdit = Boolean(id);

    const events = [];
    if (document.getElementById('webhook-event-down')?.checked) events.push('service.down');
    if (document.getElementById('webhook-event-recovered')?.checked) events.push('service.recovered');
    if (document.getElementById('webhook-event-degraded')?.checked) events.push('service.degraded');
    const is_active = document.getElementById('webhook-active')?.checked ? 1 : 0;

    // For edits: send secret as null to clear, empty string means "keep existing"
    const payload = { name, url, events, is_active };
    if (isEdit) {
        payload.secret = secretRaw.length > 0 ? secretRaw : undefined;
    } else {
        payload.secret = secretRaw.length > 0 ? secretRaw : null;
    }

    try {
        const endpoint = isEdit ? `/api/webhooks/${id}` : '/api/webhooks';
        const method = isEdit ? 'PUT' : 'POST';
        await apiFetch(endpoint, { method, body: JSON.stringify(payload) });
        closeWebhookForm();
        await loadWebhooks();
    } catch (err) {
        if (errDiv) {
            errDiv.textContent = err.message || 'Failed to save webhook.';
            errDiv.classList.remove('hidden');
        }
    }
}

async function deleteWebhook(id) {
    if (!confirm('Delete this webhook?')) return;
    try {
        await apiFetch(`/api/webhooks/${id}`, { method: 'DELETE' });
        await loadWebhooks();
    } catch (err) {
        alert(`Could not delete webhook: ${err.message}`);
    }
}

async function testWebhook(id, button) {
    if (button) { button.disabled = true; button.textContent = 'Sending...'; }
    try {
        const result = await apiFetch(`/api/webhooks/${id}/test`, { method: 'POST' });
        alert(`Test delivery successful! Server responded: HTTP ${result.status}`);
    } catch (err) {
        alert(`Test delivery failed: ${err.message}`);
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Test'; }
    }
}

