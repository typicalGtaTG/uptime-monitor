// public/js/main.js

import { initializeAuth } from './auth.js';
import { showManageServicePage, loadServices, initializeMultiSelectListeners } from './ui.js';
import { apiFetch } from './api.js';

// --- One-Time Initializations ---
initializeAuth();
initializeMultiSelectListeners(); // FIX: Set up multi-select listeners once.

// --- Event Listeners for UI interaction ---

// "Add New Service" button in the header
document.getElementById('add-service-button').addEventListener('click', () => {
    showManageServicePage();
});

// "Cancel" button on the manage service page
document.getElementById('cancel-manage-button').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('auth-change'));
});

// Form submission for adding/editing a service
document.getElementById('manage-service-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('service-id').value;
    
    const selectedLocations = Array.from(document.querySelectorAll('#tags-container .tag'))
        .map(tag => ({ "value": tag.dataset.code, "type": "country" }));
    
    const serviceData = {
        name: document.getElementById('service-name').value,
        type: document.getElementById('service-type').value,
        target: document.getElementById('service-target').value,
        interval: parseInt(document.getElementById('service-interval').value, 10) * 1000,
        locations: selectedLocations
    };

    try {
        const endpoint = id ? `/api/services/${id}` : '/api/services';
        const method = id ? 'PUT' : 'POST';
        await apiFetch(endpoint, { method, body: JSON.stringify(serviceData) });
        window.dispatchEvent(new CustomEvent('auth-change'));
    } catch (error) { 
        alert(`Error saving service: ${error.message}`); 
    }
});

// Event delegation for edit/delete buttons on service cards
document.getElementById('services-container').addEventListener('click', async (e) => {
    const serviceId = e.target.dataset.id;
    if (!serviceId) return;

    if (e.target.classList.contains('delete-service-button')) {
        if (confirm('Are you sure you want to delete this service?')) {
            try {
                await apiFetch(`/api/services/${serviceId}`, { method: 'DELETE' });
                loadServices();
            } catch (error) {
                alert(error.message);
            }
        }
    } else if (e.target.classList.contains('edit-service-button')) {
        showManageServicePage(serviceId);
    }
});
