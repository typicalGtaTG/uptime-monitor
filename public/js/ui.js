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
    ]
};

const uptimeCharts = {};
let servicesCache = [];
let multiSelectInitialized = false;

// --- Navigation & Core UI ---
export function navigate(viewName) {
    Object.values(views).forEach(v => v.classList.add('hidden'));
    views[viewName].classList.remove('hidden');
}

export async function loadServices() {
    // Add refreshing animation before fetching data
    document.querySelectorAll('.service-card').forEach(card => {
        card.classList.remove('status-up', 'status-down', 'status-pending');
        card.classList.add('status-refreshing');
    });

    try {
        servicesCache = await apiFetch('/api/services');
        const container = document.getElementById('services-container');
        container.innerHTML = '';
        if (servicesCache.length === 0) {
            container.innerHTML = `<div class="col-span-full text-center text-slate-400 glass p-8">You haven't added any services yet. Click "Add New Service" to get started.</div>`;
            return;
        }
        servicesCache.forEach(renderServiceCard);
    } catch (error) {
        console.error(error.message);
    }
}

function renderServiceCard(service) {
    const container = document.getElementById('services-container');
    const status = service.status || 'Pending';
    const statusClass = `status-${status.toLowerCase()}`;
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
                    <p class="text-sm text-slate-400 truncate">${service.target}</p>
                </div>
                <div class="text-right">
                    <div class="font-bold text-lg ${status === 'Up' ? 'text-green-400' : 'text-red-400'}">${status}</div>
                    <div class="text-xs text-slate-400">${service.lastResponseTime ?? 'N/A'} ms</div>
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
    const selectedCodes = selectedLocations.map(loc => loc.value);

    selectedCodes.forEach(code => {
        const locationData = allFlattenedLocations.find(l => l.code === code);
        if (locationData) addTag(locationData);
    });

    for (const continent in allLocations) {
        const continentHeader = document.createElement('div');
        continentHeader.className = 'dropdown-header';
        continentHeader.textContent = continent;
        dropdown.appendChild(continentHeader);

        allLocations[continent].forEach(loc => {
            if (!selectedCodes.includes(loc.code)) {
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
    tag.innerHTML = `<span>${locationData.name} (${locationData.code})</span><span class="tag-close">&times;</span>`;
    tagsContainer.appendChild(tag);
}

function createDropdownItem(locationData) {
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.dataset.code = locationData.code;
    item.dataset.name = locationData.name;
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
            const locationData = { code: item.dataset.code, name: item.dataset.name };
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
                .map(t => ({ value: t.dataset.code }));
            populateMultiSelect(currentSelected);
            tag.remove();
        }
    });
}
