// public/js/main.js

import { handleAuthFormSubmit, toggleAuthMode, handleLogout, checkAuthState } from './auth.js';
import { showManageServicePage, loadServices, openDetailModal, closeDetailModal } from './ui.js';
import { apiFetch } from './api.js';

// This is the main entry point for the application.
// We wrap everything in this event listener to ensure the HTML is fully loaded.
document.addEventListener('DOMContentLoaded', () => {

    // --- Use a single, delegated event listener for all clicks ---
    document.body.addEventListener('click', (e) => {
        // Find the closest interactive element (button or link) that was clicked
        const targetButton = e.target.closest('button, a');

        // Handle clicks inside the services container (cards, edit, delete)
        const servicesContainer = e.target.closest('#services-container');
        if (servicesContainer) {
            handleServicesContainerClick(e);
            return; // Stop further processing to avoid conflicts
        }
        
        // If no button was clicked, do nothing
        if (!targetButton) return;

        // Handle other buttons based on their ID
        switch (targetButton.id) {
            case 'toggle-auth-mode':
                toggleAuthMode(e);
                break;
            case 'logout-button':
                handleLogout();
                break;
            case 'add-service-button':
                showManageServicePage();
                break;
            case 'cancel-manage-button':
                window.dispatchEvent(new CustomEvent('auth-change'));
                break;
            case 'modal-close-button':
                closeDetailModal();
                break;
        }
    });

    // --- Use a single, delegated event listener for all form submissions ---
    document.body.addEventListener('submit', (e) => {
        const form = e.target.closest('form');
        if (!form) return;

        switch (form.id) {
            case 'auth-form':
                handleAuthFormSubmit(e);
                break;
            case 'manage-service-form':
                handleManageServiceSubmit(e);
                break;
        }
    });

    // Custom event listener to re-check auth state from other files
    window.addEventListener('auth-change', checkAuthState);

    // Initial check to see if the user is already logged in
    checkAuthState();
});

// --- Event Handler Functions ---

async function handleManageServiceSubmit(e) {
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
        window.dispatchEvent(new CustomEvent('auth-change')); // Go back to dashboard
    } catch (error) { 
        alert(`Error saving service: ${error.message}`); 
    }
}

async function handleServicesContainerClick(e) {
    const card = e.target.closest('.service-card');
    if (!card) return;

    const serviceId = card.dataset.serviceId;
    
    // Check if an edit or delete button was clicked within the card
    if (e.target.closest('.edit-service-button')) {
        showManageServicePage(serviceId);
    } else if (e.target.closest('.delete-service-button')) {
        if (confirm('Are you sure you want to delete this service?')) {
            try {
                await apiFetch(`/api/services/${serviceId}`, { method: 'DELETE' });
                loadServices();
            } catch (error) {
                alert(error.message);
            }
        }
    } else {
        // If the card itself (but not a button) was clicked, open the detail modal
        openDetailModal(serviceId);
    }
}
