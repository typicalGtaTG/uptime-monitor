// public/js/main.js

import { handleAuthFormSubmit, toggleAuthMode, handleLogout, checkAuthState } from './auth.js';
import { showManageServicePage, loadServices, openDetailModal, closeDetailModal, switchModalTab, showSettingsPage, showToolsPage, openWebhookForm, closeWebhookForm, loadWebhooks, handleWebhookFormSubmit } from './ui.js';
import { apiFetch } from './api.js';
import { ensureWorldDotMap } from './worldDotMap.js';

const toolsRegionCoordinates = {
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
    AU: { lat: -25.3, lon: 133.8 },
    LOCAL: { lat: 0, lon: 0 }
};

let activeToolsJobId = null;
let toolsJobPollTimer = null;
let toolsMapInstance = null;
let latestToolsSnapshot = null;
let toolsReplayTimer = null;
let toolsReplayStep = 1;
let toolsReplayUserPinned = false;

async function stopActiveToolsJob({ fireAndForget = false } = {}) {
    if (!activeToolsJobId) return;

    const jobId = activeToolsJobId;
    activeToolsJobId = null;
    stopToolsJobPolling();
    stopToolsReplayPlayback();

    const token = localStorage.getItem('accessToken');
    if (!token) return;

    const stopUrl = `/api/tools/jobs/${jobId}/stop`;

    if (fireAndForget) {
        fetch(stopUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            keepalive: true
        }).catch(() => {});
        return;
    }

    try {
        await apiFetch(stopUrl, { method: 'POST' });
    } catch {
        // Best effort stop. Job retention cleanup handles stale sessions.
    }
}

// This is the main entry point for the application.
// We wrap everything in this event listener to ensure the HTML is fully loaded.
document.addEventListener('DOMContentLoaded', () => {

    function getProfileMenuElements() {
        const dropdown = document.getElementById('profile-menu-dropdown');
        const toggle = document.getElementById('profile-menu-toggle');
        const items = dropdown
            ? Array.from(dropdown.querySelectorAll('.profile-menu-item'))
            : [];
        return { dropdown, toggle, items };
    }

    function closeProfileMenu({ focusToggle = false } = {}) {
        const { dropdown, toggle } = getProfileMenuElements();
        if (!dropdown) return;
        dropdown.classList.add('hidden');
        if (toggle) {
            toggle.setAttribute('aria-expanded', 'false');
            if (focusToggle) toggle.focus();
        }
    }

    function openProfileMenu({ focusFirstItem = false } = {}) {
        const { dropdown, toggle, items } = getProfileMenuElements();
        if (!dropdown) return;
        dropdown.classList.remove('hidden');
        if (toggle) toggle.setAttribute('aria-expanded', 'true');
        if (focusFirstItem && items.length > 0) {
            items[0].focus();
        }
    }
    // --- Use a single, delegated event listener for all clicks ---
    document.body.addEventListener('click', async (e) => {
        const profileMenuWrapper = document.getElementById('profile-menu-wrapper');
        const profileMenuDropdown = document.getElementById('profile-menu-dropdown');
        const profileMenuToggle = document.getElementById('profile-menu-toggle');
        const clickedInsideProfileMenu = e.target.closest('#profile-menu-wrapper');
        if (profileMenuDropdown && !clickedInsideProfileMenu) {
            closeProfileMenu();
        }

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
            case 'add-service-button':
                showManageServicePage();
                break;
            case 'open-tv-button':
                await stopActiveToolsJob({ fireAndForget: true });
                window.location.href = '/tv';
                break;
            case 'open-tools-button':
                stopToolsJobPolling();
                stopToolsReplayPlayback();
                activeToolsJobId = null;
                latestToolsSnapshot = null;
                toolsReplayStep = 1;
                toolsReplayUserPinned = false;
                updateToolsReplayControls(null);
                showToolsPage();
                switchToolsTab('http');
                break;
            case 'cancel-tools-button':
                await stopActiveToolsJob();
                latestToolsSnapshot = null;
                toolsReplayStep = 1;
                toolsReplayUserPinned = false;
                updateToolsReplayControls(null);
                window.dispatchEvent(new CustomEvent('auth-change'));
                break;
            case 'tools-tab-http':
                switchToolsTab('http');
                break;
            case 'tools-tab-dns':
                switchToolsTab('dns');
                break;
            case 'tools-tab-ping':
                switchToolsTab('ping');
                break;
            case 'tools-tab-traceroute':
                switchToolsTab('traceroute');
                break;
            case 'tools-tab-mtr':
                switchToolsTab('mtr');
                break;
            case 'profile-menu-toggle':
                if (profileMenuDropdown) {
                    const isOpen = !profileMenuDropdown.classList.contains('hidden');
                    if (isOpen) {
                        closeProfileMenu();
                    } else {
                        openProfileMenu();
                    }
                }
                break;
            case 'profile-menu-settings':
                closeProfileMenu();
                showSettingsPage();
                break;
            case 'profile-menu-logout':
                closeProfileMenu();
                handleLogout();
                break;
            case 'retry-load-services':
                loadServices();
                break;
            case 'cancel-manage-button':
                window.dispatchEvent(new CustomEvent('auth-change'));
                break;
            case 'cancel-settings-button':
                window.dispatchEvent(new CustomEvent('auth-change'));
                break;
            case 'modal-close-button':
                closeDetailModal();
                break;
            case 'modal-tab-overview':
                switchModalTab('overview');
                break;
            case 'modal-tab-diagnostics':
                switchModalTab('diagnostics');
                break;
            case 'tools-replay-play':
                toggleToolsReplayPlayback();
                break;
            case 'add-webhook-button':
                openWebhookForm();
                break;
            case 'webhook-form-close':
            case 'webhook-form-cancel':
                closeWebhookForm();
                break;
        }
    });

    document.body.addEventListener('input', (e) => {
        if (e.target?.id !== 'tools-replay-slider') return;
        const nextStep = Number(e.target.value || 1);
        stopToolsReplayPlayback();
        toolsReplayUserPinned = true;
        toolsReplayStep = Number.isFinite(nextStep) ? nextStep : 1;
        renderToolsSnapshotForReplay();
    });

    document.addEventListener('keydown', (e) => {
        const { dropdown, toggle, items } = getProfileMenuElements();
        if (!dropdown || !toggle) return;

        const isOpen = !dropdown.classList.contains('hidden');
        const activeElement = document.activeElement;
        const focusIndex = items.findIndex(item => item === activeElement);

        if (e.key === 'Escape') {
            if (!isOpen) return;
            e.preventDefault();
            closeProfileMenu({ focusToggle: true });
            return;
        }

        if (e.key === 'ArrowDown') {
            if (activeElement === toggle && !isOpen) {
                e.preventDefault();
                openProfileMenu({ focusFirstItem: true });
                return;
            }

            if (isOpen && (focusIndex >= 0 || activeElement === toggle)) {
                e.preventDefault();
                const nextIndex = focusIndex >= 0
                    ? (focusIndex + 1) % items.length
                    : 0;
                items[nextIndex]?.focus();
            }
            return;
        }

        if (e.key === 'ArrowUp' && isOpen && (focusIndex >= 0 || activeElement === toggle)) {
            e.preventDefault();
            const previousIndex = focusIndex >= 0
                ? (focusIndex - 1 + items.length) % items.length
                : items.length - 1;
            items[previousIndex]?.focus();
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
            case 'settings-email-form':
                handleSettingsEmailSubmit(e);
                break;
            case 'settings-password-form':
                handleSettingsPasswordSubmit(e);
                break;
            case 'tools-form':
                handleToolsSubmit(e);
                break;
            case 'webhook-form':
                handleWebhookFormSubmit(e);
                break;
        }
    });

    // Custom event listener to re-check auth state from other files
    window.addEventListener('auth-change', checkAuthState);
    window.addEventListener('tools-view-leave', () => {
        stopActiveToolsJob();
    });
    window.addEventListener('beforeunload', () => {
        stopActiveToolsJob({ fireAndForget: true });
    });
    window.addEventListener('pagehide', () => {
        stopActiveToolsJob({ fireAndForget: true });
    });

    // Initial check to see if the user is already logged in
    checkAuthState();
});

// --- Event Handler Functions ---

async function handleManageServiceSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('service-id').value;
    const selectedLocations = Array.from(document.querySelectorAll('#tags-container .tag'))
        .map(tag => ({
            value: tag.dataset.code,
            type: tag.dataset.type || 'country'
        }));
    
    const serviceData = {
        name: document.getElementById('service-name').value,
        type: document.getElementById('service-type').value,
        target: document.getElementById('service-target').value,
        interval: parseInt(document.getElementById('service-interval').value, 10) * 1000,
        locations: selectedLocations,
        alerts_enabled: document.getElementById('service-alerts-enabled')?.checked ? 1 : 0
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

async function handleSettingsEmailSubmit(e) {
    e.preventDefault();
    const email = document.getElementById('settings-email').value;
    const currentPassword = document.getElementById('settings-email-password').value;

    try {
        await apiFetch('/api/account/email', {
            method: 'PUT',
            body: JSON.stringify({ email, currentPassword })
        });
        alert('Email updated successfully.');
        document.getElementById('settings-email-password').value = '';
        await showSettingsPage();
    } catch (error) {
        alert(`Could not update email: ${error.message}`);
    }
}

async function handleSettingsPasswordSubmit(e) {
    e.preventDefault();
    const currentPassword = document.getElementById('settings-current-password').value;
    const newPassword = document.getElementById('settings-new-password').value;

    try {
        await apiFetch('/api/account/password', {
            method: 'PUT',
            body: JSON.stringify({ currentPassword, newPassword })
        });
        alert('Password updated successfully.');
        document.getElementById('settings-current-password').value = '';
        document.getElementById('settings-new-password').value = '';
    } catch (error) {
        alert(`Could not update password: ${error.message}`);
    }
}

function switchToolsTab(tool) {
    const tabs = [
        document.getElementById('tools-tab-http'),
        document.getElementById('tools-tab-dns'),
        document.getElementById('tools-tab-ping'),
        document.getElementById('tools-tab-traceroute'),
        document.getElementById('tools-tab-mtr')
    ].filter(Boolean);

    const panels = {
        http: document.getElementById('tools-panel-http'),
        dns: document.getElementById('tools-panel-dns'),
        ping: document.getElementById('tools-panel-ping'),
        traceroute: document.getElementById('tools-panel-traceroute'),
        mtr: document.getElementById('tools-panel-mtr')
    };

    tabs.forEach(tab => {
        const isActive = tab.dataset.tool === tool;
        tab.classList.toggle('active', isActive);
    });

    Object.entries(panels).forEach(([key, panel]) => {
        if (!panel) return;
        panel.classList.toggle('hidden', key !== tool);
    });

    setToolsRequiredFields(tool);

    const activeToolInput = document.getElementById('tools-active-tool');
    if (activeToolInput) activeToolInput.value = tool;
}

function setToolsRequiredFields(activeTool) {
    const fields = {
        http: document.getElementById('tools-http-target'),
        dns: document.getElementById('tools-dns-target'),
        ping: document.getElementById('tools-ping-target'),
        traceroute: document.getElementById('tools-traceroute-target'),
        mtr: document.getElementById('tools-mtr-target')
    };

    Object.entries(fields).forEach(([tool, input]) => {
        if (!input) return;
        input.required = tool === activeTool;
    });
}

function getSelectedToolLocations() {
    const checkboxes = Array.from(document.querySelectorAll('.tools-location-checkbox'));
    return checkboxes
        .filter(checkbox => checkbox.checked)
        .map(checkbox => ({
            value: checkbox.value,
            type: checkbox.dataset.type || 'country'
        }));
}

function getToolsRequestPayload() {
    const activeTool = document.getElementById('tools-active-tool')?.value || 'http';
    const locations = getSelectedToolLocations();

    const base = {
        tool: activeTool,
        locations
    };

    if (activeTool === 'dns') {
        return {
            ...base,
            target: document.getElementById('tools-dns-target')?.value || '',
            recordType: document.getElementById('tools-dns-record-type')?.value || 'A'
        };
    }

    if (activeTool === 'ping') {
        return {
            ...base,
            target: document.getElementById('tools-ping-target')?.value || '',
            timeoutMs: Number(document.getElementById('tools-ping-timeout')?.value || 5000),
            packetCount: Number(document.getElementById('tools-ping-packets')?.value || 4)
        };
    }

    if (activeTool === 'traceroute') {
        return {
            ...base,
            target: document.getElementById('tools-traceroute-target')?.value || '',
            timeoutMs: Number(document.getElementById('tools-traceroute-timeout')?.value || 5000),
            maxHops: Number(document.getElementById('tools-traceroute-max-hops')?.value || 20)
        };
    }

    if (activeTool === 'mtr') {
        return {
            ...base,
            target: document.getElementById('tools-mtr-target')?.value || '',
            cycles: Number(document.getElementById('tools-mtr-cycles')?.value || 5)
        };
    }

    return {
        ...base,
        target: document.getElementById('tools-http-target')?.value || '',
        method: document.getElementById('tools-http-method')?.value || 'GET',
        timeoutMs: Number(document.getElementById('tools-http-timeout')?.value || 5000)
    };
}

function renderToolsResult(content, isError = false) {
    const output = document.getElementById('tools-result-output');
    if (!output) return;
    output.textContent = content;
    output.classList.toggle('text-rose-300', isError);
    if (!isError) output.classList.remove('text-rose-300');
}

function rttMs(v) {
    return (v != null && Number.isFinite(Number(v))) ? `${Math.round(v)}ms` : null;
}

function pad(str, len) {
    return String(str ?? '').padEnd(len);
}

function formatPingResult(job, lines) {
    const results = Array.isArray(job.results) ? job.results : [];
    if (results.length === 0) {
        lines.push('  Waiting for probe results...');
        return lines.join('\n');
    }

    const locWidth = Math.min(40, Math.max(20, ...results.map(e => (e.locationLabel || '').length + 10)));

    lines.push(`  ${'Location'.padEnd(locWidth)}  RTTs (per packet)                 Avg       Loss`);
    lines.push('  ' + '─'.repeat(locWidth + 50));

    const allRtts = [];
    results.forEach(entry => {
        const raw = entry?.raw?.result || {};
        const timings = Array.isArray(raw.timings) ? raw.timings : [];
        const stats = typeof raw.stats === 'object' && raw.stats ? raw.stats : {};

        const rtts = timings.map(t => t?.rtt).filter(r => r != null && Number.isFinite(r));
        if (entry.responseTimeMs != null && Number.isFinite(entry.responseTimeMs) && rtts.length === 0) {
            rtts.push(entry.responseTimeMs);
        }
        allRtts.push(...rtts);

        const avg = typeof stats.avg === 'number' && Number.isFinite(stats.avg)
            ? stats.avg
            : rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;

        const dropCount = typeof stats.drop === 'number' ? stats.drop : 0;
        const totalSent = typeof stats.total === 'number' ? stats.total : rtts.length || 1;
        const lossPct = typeof stats.loss === 'number'
            ? stats.loss
            : totalSent > 0 ? Math.round((dropCount / totalSent) * 100) : (entry.ok ? 0 : 100);

        const rttDisplay = rtts.length > 0
            ? rtts.map(r => `${Math.round(r)}ms`).join('  ')
            : entry.ok ? '—' : 'timeout';

        const srcTag = entry.source === 'local' ? ' (local)' : '';
        const lossStr = `${lossPct}%`;
        const avgStr = avg != null ? `${avg.toFixed(1)}ms` : (entry.ok ? '—' : 'N/A');

        lines.push(`  ${pad((entry.locationLabel || entry.locationCode || 'Unknown') + srcTag, locWidth)}  ${pad(rttDisplay, 34)}${pad(avgStr, 10)}${lossStr}`);

        // Show resolved address if available
        if (raw.resolvedAddress && raw.resolvedAddress !== job.target) {
            lines.push(`  ${pad('', locWidth)}  → ${raw.resolvedAddress}${raw.resolvedHostname && raw.resolvedHostname !== raw.resolvedAddress ? ` (${raw.resolvedHostname})` : ''}`);
        }
    });

    if (allRtts.length > 0) {
        const min = Math.min(...allRtts).toFixed(1);
        const max = Math.max(...allRtts).toFixed(1);
        const avg = (allRtts.reduce((a, b) => a + b, 0) / allRtts.length).toFixed(1);
        lines.push('  ' + '─'.repeat(locWidth + 50));
        lines.push(`  All probes — rtt min/avg/max = ${min}/${avg}/${max} ms   probes: ${results.length}`);
    }

    return lines.join('\n');
}

function formatHttpResult(job, lines) {
    const results = Array.isArray(job.results) ? job.results : [];
    if (results.length === 0) {
        lines.push('  Waiting for probe results...');
        return lines.join('\n');
    }

    const locWidth = Math.min(38, Math.max(20, ...results.map(e => (e.locationLabel || '').length + 10)));
    lines.push(`  ${'Location'.padEnd(locWidth)} ${'Status'.padEnd(12)} ${'Total'.padEnd(9)} ${'DNS'.padEnd(8)} ${'TLS'.padEnd(8)} ${'TTFB'.padEnd(8)} Download`);
    lines.push('  ' + '─'.repeat(locWidth + 60));

    results.forEach(entry => {
        const raw = entry?.raw?.result || {};
        const t = raw.timings || {};
        const code = raw.statusCode || raw.status;
        let statusStr;
        if (entry.ok) {
            statusStr = code ? `${code} OK` : 'OK';
        } else if (entry.raw === null) {
            // API-level failure — extract HTTP status from reason like "API 422: ..."
            const apiCode = entry.reason?.match(/^API (\d{3})/)?.[1];
            statusStr = apiCode ? `API ${apiCode}` : 'API Err';
        } else {
            statusStr = code ? `ERR ${code}` : 'FAIL';
        }
        const p = (v) => rttMs(v) ?? '—';
        const srcTag = entry.source === 'local' ? ' (local)' : '';
        lines.push(`  ${pad((entry.locationLabel || entry.locationCode || 'Unknown') + srcTag, locWidth)} ${pad(statusStr, 12)} ${pad(p(t.total ?? entry.responseTimeMs), 9)} ${pad(p(t.dns), 8)} ${pad(p(t.tls), 8)} ${pad(p(t.firstByte ?? t.ttfb), 8)} ${p(t.download)}`);
        if (!entry.ok && entry.reason && entry.raw === null) {
            lines.push(`  ${pad('', locWidth)} ${entry.reason.slice(0, 80)}`);
        }
    });

    return lines.join('\n');
}

function formatDnsResult(job, lines) {
    const results = Array.isArray(job.results) ? job.results : [];
    if (results.length === 0) {
        lines.push('  Waiting for probe results...');
        return lines.join('\n');
    }

    results.forEach(entry => {
        const raw = entry?.raw?.result || {};
        const answers = Array.isArray(raw.answers) ? raw.answers : [];
        const t = raw.timings;
        const time = rttMs(entry.responseTimeMs ?? (typeof t === 'object' && !Array.isArray(t) ? t?.total : null)) ?? '—';
        const srcTag = entry.source === 'local' ? ' (local)' : '';
        const loc = (entry.locationLabel || entry.locationCode || 'Unknown') + srcTag;
        const okStr = entry.ok ? 'OK' : 'FAIL';
        lines.push(`  ${loc}  ${okStr}  ${time}`);

        if (answers.length > 0) {
            answers.forEach(a => {
                const val = a.value || a.address || a.data || JSON.stringify(a);
                const ttlStr = a.ttl != null ? `  TTL ${a.ttl}s` : '';
                lines.push(`    ${pad(a.type || '', 7)} ${val}${ttlStr}`);
            });
        } else if (!entry.ok) {
            lines.push(`    (${entry.reason || 'No records returned'})`);
        }
        lines.push('');
    });

    return lines.join('\n');
}

function formatTracerouteResult(job, lines) {
    const results = Array.isArray(job.results) ? job.results : [];
    if (results.length === 0) {
        lines.push('  Waiting for probe results...');
        return lines.join('\n');
    }

    results.forEach(entry => {
        const raw = entry?.raw?.result || {};
        const hops = Array.isArray(raw.hops) ? raw.hops : [];
        const srcTag = entry.source === 'local' ? ' (local)' : '';
        const loc = (entry.locationLabel || entry.locationCode || 'Unknown') + srcTag;
        lines.push(`  From: ${loc}`);
        lines.push('  ' + '─'.repeat(65));

        if (hops.length > 0) {
            hops.forEach((hop, i) => {
                const hostname = hop.resolvedHostname || hop.hostname || '';
                const addr = hop.resolvedAddress || hop.address || '';
                const host = hostname && hostname !== addr ? `${hostname} (${addr || '?'})` : (addr || '?');
                const hopTimings = Array.isArray(hop.timings) ? hop.timings : [];
                const rttDisplay = hopTimings.length > 0
                    ? hopTimings.map(t => t.rtt != null ? `${t.rtt.toFixed(1)}ms` : '*').join('   ')
                    : '* * *';
                lines.push(`  ${String(i + 1).padStart(3)}  ${pad(host, 50)} ${rttDisplay}`);
            });
        } else {
            lines.push(`  ${entry.ok ? '' : 'FAIL: '}${entry.reason || 'No hop data received.'}`);
        }
        lines.push('');
    });

    return lines.join('\n');
}

function formatMtrResult(job, lines) {
    const results = Array.isArray(job.results) ? job.results : [];
    if (results.length === 0) {
        lines.push('  Waiting for probe results...');
        return lines.join('\n');
    }

    results.forEach(entry => {
        const raw = entry?.raw?.result || {};
        const hops = Array.isArray(raw.hops) ? raw.hops : [];
        const srcTag = entry.source === 'local' ? ' (local)' : '';
        const loc = (entry.locationLabel || entry.locationCode || 'Unknown') + srcTag;
        lines.push(`  From: ${loc}`);
        lines.push(`  ${'Hop'.padEnd(5)} ${'Host'.padEnd(50)} ${'Avg'.padEnd(10)} ${'Min'.padEnd(10)} ${'Max'.padEnd(10)} Loss`);
        lines.push('  ' + '─'.repeat(90));

        if (hops.length > 0) {
            hops.forEach((hop, i) => {
                const hostname = hop.resolvedHostname || hop.hostname || '';
                const addr = hop.resolvedAddress || hop.address || '';
                const host = hostname && hostname !== addr ? `${hostname} (${addr || '?'})` : (addr || '?');
                const s = hop.stats || {};
                const fmt = (v) => rttMs(v) ?? '—';
                const loss = typeof s.loss === 'number' ? `${s.loss}%` : '—';
                lines.push(`  ${String(i + 1).padStart(3)}  ${pad(host, 50)} ${pad(fmt(s.avg), 10)} ${pad(fmt(s.min), 10)} ${pad(fmt(s.max), 10)} ${loss}`);
            });
        } else {
            lines.push(`  ${entry.ok ? '' : 'FAIL: '}${entry.reason || 'No hop data received.'}`);
        }
        lines.push('');
    });

    return lines.join('\n');
}

function formatToolResult(result) {
    const job = result;
    if (!job || typeof job !== 'object') {
        return String(job || 'No result');
    }

    const tool = String(job.tool || '').toUpperCase();
    const statusLabel = { running: 'RUNNING…', completed: 'DONE', failed: 'FAILED', stopped: 'STOPPED', stopping: 'STOPPING…' }[job.status] || (job.status || '').toUpperCase();
    const packetSuffix = job.tool === 'ping' && job.packetCount > 1 ? ` — ${job.packetCount} packets` : '';
    const locCount = (job.locations || []).filter(l => l.type !== 'local').length;
    const locSuffix = locCount > 0 ? ` — ${locCount} location${locCount !== 1 ? 's' : ''}` : '';

    const lines = [];
    lines.push(`${tool} ${job.target || '—'}${packetSuffix}${locSuffix}   [${statusLabel}]`);
    lines.push('─'.repeat(72));

    if (job.tool === 'ping')       return formatPingResult(job, lines);
    if (job.tool === 'http')       return formatHttpResult(job, lines);
    if (job.tool === 'dns')        return formatDnsResult(job, lines);
    if (job.tool === 'traceroute') return formatTracerouteResult(job, lines);
    if (job.tool === 'mtr')        return formatMtrResult(job, lines);

    // Fallback for unknown tools
    const results = Array.isArray(job.results) ? job.results : [];
    results.forEach(entry => {
        const ok = entry.ok ? 'OK' : 'FAIL';
        const t = rttMs(entry.responseTimeMs) ?? 'N/A';
        lines.push(`  ${entry.locationLabel || entry.locationCode || 'Unknown'}  ${ok}  ${t}  ${entry.reason || ''}`);
    });
    if (job.error) lines.push(`\nError: ${job.error}`);
    return lines.join('\n');
}

function getCoordinatesForToolsLocation(locationCode, locationLabel) {
    const code = String(locationCode || '').toUpperCase();
    if (toolsRegionCoordinates[code]) {
        return toolsRegionCoordinates[code];
    }

    const basis = String(locationLabel || code || 'UNKNOWN');
    let hash = 0;
    for (let index = 0; index < basis.length; index += 1) {
        hash = ((hash << 5) - hash) + basis.charCodeAt(index);
        hash |= 0;
    }

    return {
        lat: -50 + (Math.abs(hash) % 100),
        lon: -170 + (Math.abs(hash * 7) % 340)
    };
}

function getToolsMarkerColor(result) {
    return result.ok ? '#2de2e6' : '#ff4da6';
}

function renderToolsMap(job) {
    void renderToolsMapAsync(job);
}

async function renderToolsMapAsync(job) {
    const mapWrapper = document.getElementById('tools-map-wrapper');
    if (!mapWrapper) return;

    const results = Array.isArray(job?.results) ? job.results : [];
    const latestByLocation = new Map();
    results.forEach(result => {
        const key = `${result.source || 'unknown'}:${result.locationCode || result.locationLabel || 'unknown'}`;
        latestByLocation.set(key, result);
    });

    if (latestByLocation.size <= 1) {
        mapWrapper.classList.add('hidden');
        if (toolsMapInstance) toolsMapInstance.setPoints([]);
        return;
    }

    const mapElement = document.getElementById('tools-live-map');
    if (!mapElement) {
        mapWrapper.classList.add('hidden');
        return;
    }

    toolsMapInstance = toolsMapInstance || await ensureWorldDotMap(mapElement);
    if (!toolsMapInstance) {
        mapWrapper.classList.add('hidden');
        return;
    }

    mapWrapper.classList.remove('hidden');
    const points = [];

    for (const result of latestByLocation.values()) {
        const coordinates = getCoordinatesForToolsLocation(result.locationCode, result.locationLabel);
        const rtt = Number.isFinite(Number(result.responseTimeMs)) ? `${result.responseTimeMs}ms` : 'N/A';
        const title = `${result.locationLabel || result.locationCode || 'UNKNOWN'} • ${result.source?.toUpperCase() || 'UNKNOWN'} • ${result.ok ? 'OK' : 'FAIL'} • ${rtt}${result.reason ? ` • ${result.reason}` : ''}`;

        points.push({
            lat: coordinates.lat,
            lon: coordinates.lon,
            color: getToolsMarkerColor(result),
            label: title
        });
    }

    toolsMapInstance.setPoints(points);
}

function stopToolsJobPolling() {
    if (toolsJobPollTimer) {
        clearTimeout(toolsJobPollTimer);
        toolsJobPollTimer = null;
    }
}

function stopToolsReplayPlayback() {
    if (toolsReplayTimer) {
        clearInterval(toolsReplayTimer);
        toolsReplayTimer = null;
    }

    const playButton = document.getElementById('tools-replay-play');
    if (playButton) {
        playButton.textContent = 'Play';
    }
}

function getToolsReplayMaxStep(job) {
    const results = Array.isArray(job?.results) ? job.results : [];
    if (results.length === 0) return 1;

    let maxStep = 1;
    for (const result of results) {
        const step = Number(result?.packetIndex || 1);
        if (Number.isFinite(step) && step > maxStep) {
            maxStep = step;
        }
    }

    return Math.max(1, maxStep);
}

function buildReplaySnapshot(job) {
    const replayMaxStep = getToolsReplayMaxStep(job);
    const normalizedStep = Math.min(Math.max(1, Number(toolsReplayStep || 1)), replayMaxStep);
    const results = Array.isArray(job?.results) ? job.results : [];
    const filteredResults = results.filter(result => Number(result?.packetIndex || 1) <= normalizedStep);

    return {
        ...job,
        results: filteredResults,
        replayStep: normalizedStep,
        replayMaxStep
    };
}

function updateToolsReplayControls(job) {
    const controls = document.getElementById('tools-replay-controls');
    const slider = document.getElementById('tools-replay-slider');
    const stepLabel = document.getElementById('tools-replay-step-label');
    const playButton = document.getElementById('tools-replay-play');
    if (!controls || !slider || !stepLabel || !playButton) return;

    if (!job) {
        controls.classList.add('hidden');
        slider.value = '1';
        slider.max = '1';
        stepLabel.textContent = 'Packet 1 / 1';
        playButton.textContent = 'Play';
        return;
    }

    const maxStep = getToolsReplayMaxStep(job);
    if (maxStep <= 1) {
        controls.classList.add('hidden');
        slider.value = '1';
        slider.max = '1';
        stepLabel.textContent = 'Packet 1 / 1';
        playButton.textContent = 'Play';
        return;
    }

    controls.classList.remove('hidden');
    const step = Math.min(Math.max(1, Number(toolsReplayStep || maxStep)), maxStep);
    slider.max = String(maxStep);
    slider.value = String(step);
    stepLabel.textContent = `Packet ${step} / ${maxStep}`;
    playButton.textContent = toolsReplayTimer ? 'Pause' : 'Play';
}

function renderToolsSnapshotForReplay() {
    if (!latestToolsSnapshot) return;

    const snapshotForDisplay = buildReplaySnapshot(latestToolsSnapshot);
    toolsReplayStep = snapshotForDisplay.replayStep;
    updateToolsReplayControls(latestToolsSnapshot);
    renderToolsResult(formatToolResult(snapshotForDisplay), snapshotForDisplay.status === 'failed');
    renderToolsMap(snapshotForDisplay);
}

function toggleToolsReplayPlayback() {
    if (!latestToolsSnapshot) return;

    const maxStep = getToolsReplayMaxStep(latestToolsSnapshot);
    if (maxStep <= 1) return;

    if (toolsReplayTimer) {
        stopToolsReplayPlayback();
        return;
    }

    toolsReplayUserPinned = true;
    const playButton = document.getElementById('tools-replay-play');
    if (playButton) playButton.textContent = 'Pause';

    toolsReplayTimer = setInterval(() => {
        const currentMax = getToolsReplayMaxStep(latestToolsSnapshot);
        if (toolsReplayStep < currentMax) {
            toolsReplayStep += 1;
            renderToolsSnapshotForReplay();
            return;
        }

        if (latestToolsSnapshot.status !== 'running') {
            stopToolsReplayPlayback();
        }
    }, 900);
}

function scheduleToolsJobPoll(jobId, runButton) {
    stopToolsJobPolling();
    toolsJobPollTimer = setTimeout(() => {
        pollToolsJob(jobId, runButton);
    }, 1000);
}

async function pollToolsJob(jobId, runButton) {
    try {
        const snapshot = await apiFetch(`/api/tools/jobs/${jobId}`);
        latestToolsSnapshot = snapshot;

        const maxStep = getToolsReplayMaxStep(snapshot);
        if (maxStep > 1) {
            if (!toolsReplayUserPinned && !toolsReplayTimer) {
                toolsReplayStep = maxStep;
            } else {
                toolsReplayStep = Math.min(Math.max(1, toolsReplayStep), maxStep);
            }
        } else {
            toolsReplayStep = 1;
            toolsReplayUserPinned = false;
            stopToolsReplayPlayback();
        }

        renderToolsSnapshotForReplay();

        if (snapshot.status === 'running' || snapshot.status === 'stopping') {
            scheduleToolsJobPoll(jobId, runButton);
            return;
        }

        activeToolsJobId = null;
        stopToolsJobPolling();
        if (runButton) {
            runButton.disabled = false;
            runButton.textContent = 'Run Check';
        }
    } catch (error) {
        renderToolsResult(`Error while polling live results: ${error.message}`, true);
        activeToolsJobId = null;
        stopToolsJobPolling();
        if (runButton) {
            runButton.disabled = false;
            runButton.textContent = 'Run Check';
        }
    }
}

async function handleToolsSubmit(e) {
    e.preventDefault();

    const runButton = document.getElementById('tools-run-button');
    if (runButton) {
        runButton.disabled = true;
        runButton.textContent = 'Running...';
    }

    try {
        stopToolsJobPolling();
        stopToolsReplayPlayback();
        latestToolsSnapshot = null;
        toolsReplayStep = 1;
        toolsReplayUserPinned = false;
        updateToolsReplayControls(null);

        const payload = getToolsRequestPayload();
        if (!payload.locations || payload.locations.length === 0) {
            renderToolsResult('Error: select at least one location.', true);
            if (runButton) {
                runButton.disabled = false;
                runButton.textContent = 'Run Check';
            }
            return;
        }

        const started = await apiFetch('/api/tools/run', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const jobId = started?.jobId;
        if (!jobId) {
            throw new Error('Did not receive a live job id.');
        }

        activeToolsJobId = jobId;
        renderToolsResult('Starting live run...', false);
        updateToolsReplayControls(null);
        pollToolsJob(jobId, runButton);
    } catch (error) {
        renderToolsResult(`Error: ${error.message}`, true);
        if (runButton) {
            runButton.disabled = false;
            runButton.textContent = 'Run Check';
        }
    }
}
