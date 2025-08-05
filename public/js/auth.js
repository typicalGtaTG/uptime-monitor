// public/js/auth.js

import { navigate, loadServices } from './ui.js';

let serviceCheckInterval;

export function initializeAuth() {
    document.getElementById('auth-form').addEventListener('submit', handleAuthFormSubmit);
    document.getElementById('toggle-auth-mode').addEventListener('click', toggleAuthMode);
    document.getElementById('logout-button').addEventListener('click', handleLogout);
    
    // Listen for the custom auth-change event dispatched by the API helper
    window.addEventListener('auth-change', checkAuthState);

    checkAuthState(); // Initial check on page load
}

async function handleAuthFormSubmit(e) {
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

function toggleAuthMode(e) {
    e.preventDefault();
    const authTitle = document.getElementById('auth-title');
    const isLogin = authTitle.textContent.includes('Sign in');
    authTitle.textContent = isLogin ? 'Sign up' : 'Sign in';
    e.target.textContent = isLogin ? 'Already have an account? Sign in' : "Don't have an account? Sign up";
}

function handleLogout() {
    localStorage.removeItem('accessToken');
    checkAuthState();
}

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
