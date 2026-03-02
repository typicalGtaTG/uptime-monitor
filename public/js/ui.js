// public/js/ui.js

import { apiFetch } from './api.js';

// --- DOM Elements & State ---
const views = {
    auth: document.getElementById('auth-view'),
    dashboard: document.getElementById('dashboard-view'),
    manage: document.getElementById('manage-service-view'),
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

// --- Navigation & Core UI ---
export function navigate(viewName) {
    Object.values(views).forEach(v => v.classList.add('hidden'));
    views[viewName].classList.remove('hidden');
}

export async function loadServices() {
    const container = document.getElementById('services-container');

    // Add refreshing animation before fetching data
    document.querySelectorAll('.service-card').forEach(card => {
        card.classList.remove('status-up', 'status-down', 'status-pending');
        card.classList.add('status-refreshing');
    });

    if (container && servicesCache.length === 0) {
        renderLoadingState(container);
    }

    try {
        const [servicesResponse, monitoringResponse] = await Promise.all([
            apiFetch('/api/services'),
            apiFetch('/api/services/meta/monitoring')
        ]);
        servicesCache = sortServicesByPriority(servicesResponse);
        renderMonitoringWarning(monitoringResponse);
        renderSummaryStrip(servicesCache);
        container.innerHTML = '';
        if (servicesCache.length === 0) {
            renderEmptyState(container);
            return;
        }
        servicesCache.forEach(renderServiceCard);
    } catch (error) {
        renderMonitoringWarning(null);
        renderSummaryStrip([]);
        if (container) {
            renderErrorState(container, error.message);
        }
        console.error(error.message);
    }
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
    const activeIncidentDuration = formatDurationSince(service.active_incident_since);
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
    
    const uptimeColor = service.uptime_24h >= 99.9 ? 'text-green-400' : 'text-yellow-400';
    document.getElementById('modal-uptime').className = `text-3xl font-bold ${uptimeColor}`;

    const downtimeList = document.getElementById('modal-downtime-list');
    downtimeList.innerHTML = '<li>Loading...</li>';

    modal.classList.add('visible');

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
