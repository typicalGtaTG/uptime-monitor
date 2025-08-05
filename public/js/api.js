// public/js/api.js

/**
 * A centralized helper function for making authenticated API calls.
 * It automatically handles the auth token and error responses.
 * @param {string} endpoint - The API endpoint to call (e.g., '/api/services').
 * @param {object} options - The options for the fetch call (method, body, etc.).
 * @returns {Promise<any>} - The JSON response from the API.
 */
export async function apiFetch(endpoint, options = {}) {
    options.headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        ...options.headers,
    };

    const response = await fetch(endpoint, options);

    if (response.status === 401) {
        // If unauthorized, trigger a logout and throw an error.
        localStorage.removeItem('accessToken');
        window.dispatchEvent(new CustomEvent('auth-change'));
        throw new Error('Authentication failed. Please log in again.');
    }

    if (!response.ok) {
        throw new Error(await response.text());
    }

    // Handle 204 No Content for DELETE requests
    return response.status !== 204 ? response.json() : null;
}
