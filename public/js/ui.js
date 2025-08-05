// public/js/ui.js

import { apiFetch } from './api.js';

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

export function navigate(viewName) {
    Object.values(views).forEach(v => v.classList.add('hidden'));
    views[viewName].classList.remove('hidden');
}

export async function loadServices() {
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
    const statusColor = status === 'Up' ? 'text-green-400' : 'text-red-400';
    
    // FIX: Add error handling for malformed location data
    let locationsText = "None";
    try {
        const parsedLocations = JSON.parse(service.locations || '[]');
        if (Array.isArray(parsedLocations) && parsedLocations.length > 0) {
            locationsText = parsedLocations.map(l => l.value).join(', ');
        }
    } catch (e) {
        locationsText = "Invalid Locations";
    }

    const card = document.createElement('div');
    card.className = 'glass glass-interactive p-6 flex flex-col';
    card.innerHTML = `<div class="flex-grow flex flex-col">
        <div class="flex justify-between items-start mb-2"><h3 class="text-xl font-bold text-white">${service.name}</h3><span class="font-bold text-lg ${statusColor}">${status}</span></div>
        <p class="text-sm text-slate-400 truncate">${service.target}</p>
        <p class="text-xs text-slate-500 mt-1">Avg. Response: ${service.lastResponseTime ?? 'N/A'} ms</p>
        <p class="text-xs text-slate-500 mt-1">Locations: ${locationsText}</p>
        <div class="flex-grow mt-4 min-h-[150px]"><canvas id="chart-${service.id}"></canvas></div>
    </div>
    <div class="mt-4 pt-4 border-t border-slate-700 flex items-center justify-between text-xs text-slate-400">
        <button data-id="${service.id}" class="edit-service-button font-semibold text-blue-400 hover:text-blue-300">Edit</button>
        <button data-id="${service.id}" class="delete-service-button font-semibold text-red-400 hover:text-red-300">Delete</button>
    </div>`;
    container.appendChild(card);
    loadChartForService(service.id);
}

async function loadChartForService(serviceId) {
    try {
        const history = await apiFetch(`/api/services/${serviceId}/history`);
        const labels = history.map(h => new Date(h.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
        const data = history.map(h => h.response_time); 
        const ctx = document.getElementById(`chart-${serviceId}`).getContext('2d');
        if (uptimeCharts[serviceId]) uptimeCharts[serviceId].destroy();
        uptimeCharts[serviceId] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Response Time (ms)', data: data, borderColor: 'rgba(96, 165, 250, 1)', backgroundColor: 'rgba(96, 165, 250, 0.2)',
                    fill: true, tension: 0.4, pointBackgroundColor: 'rgba(96, 165, 250, 1)', pointRadius: 2,
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true, ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(148, 163, 184, 0.1)' } },
                    x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { display: false } }
                },
                plugins: { legend: { display: false } }
            }
        });
    } catch (error) {
        console.error(`Could not load chart for service ${serviceId}`, error);
    }
}

export function showManageServicePage(serviceId = null) {
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

    // Render initial selected tags
    selectedCodes.forEach(code => {
        const locationData = allFlattenedLocations.find(l => l.code === code);
        if (locationData) addTag(locationData);
    });

    // Render available locations in dropdown
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

// FIX: Setup event listeners for the multi-select component only once.
export function initializeMultiSelectListeners() {
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
            const locationData = { code: tag.dataset.code, name: tag.dataset.name };
            // A bit complex to re-insert into the correct continent, so we'll just repopulate.
            const currentSelected = Array.from(tagsContainer.querySelectorAll('.tag'))
                .filter(t => t !== tag) // Exclude the one being removed
                .map(t => ({ value: t.dataset.code }));
            populateMultiSelect(currentSelected);
            tag.remove();
        }
    });
}
