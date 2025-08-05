// public/js/auth.js

import { navigate, loadServices } from './ui.js';

let serviceCheckInterval;

/**
 * Handles the submission of the login/registration form.
 */
export async function handleAuthFormSubmit(e) {
    e.preventDefault();
    const authTitle = document.getElementById('auth-title');
    const emailInput = document.getElementById('email-address');
    const passwordInput = document.getElementById('password');
    
    const isLogin = authTitle.textContent.includes('Sign in');
    const endpoint = isLogin ? '/api/login' : '/api/register';

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailInput.value, password: passwordInput.value })
        });

        if (!response.ok) {
            throw new Error(await response.text());
        }

        if (isLogin) {
            const { accessToken } = await response.json();
            localStorage.setItem('accessToken', accessToken);
            checkAuthState();
        } else {
            alert('Registration successful! Please log in.');
            e.target.reset();
            authTitle.textContent = 'Sign in';
            document.getElementById('toggle-auth-mode').textContent = "Don't have an account? Sign up";
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

/**
 * Toggles the auth form between login and registration modes.
 */
export function toggleAuthMode(e) {
    e.preventDefault();
    const authTitle = document.getElementById('auth-title');
    const isLogin = authTitle.textContent.includes('Sign in');
    authTitle.textContent = isLogin ? 'Sign up' : 'Sign in';
    e.target.textContent = isLogin ? 'Already have an account? Sign in' : "Don't have an account? Sign up";
}

/**
 * Logs the user out by clearing their token.
 */
export function handleLogout() {
    localStorage.removeItem('accessToken');
    checkAuthState();
}

/**
 * Checks if a user is logged in and shows the correct view.
 * This is the central function for managing the application's state.
 */
export function checkAuthState() {
    if (localStorage.getItem('accessToken')) {
        navigate('dashboard');
        loadServices();
        if (serviceCheckInterval) clearInterval(serviceCheckInterval);
        serviceCheckInterval = setInterval(loadServices, 30000);
    } else {
        navigate('auth');
        if (serviceCheckInterval) clearInterval(serviceCheckInterval);
    }
}
