/**
 * api.js — Fetch client with automatic API_KEY injection.
 * Reads the API key from localStorage and sends it as Authorization: Bearer <key>
 * on every request. Exports a single `api` object with HTTP verb helpers.
 */

const STORAGE_KEY = 'pb_api_key';

export function getApiKey() {
  return localStorage.getItem(STORAGE_KEY) || '';
}

export function setApiKey(key) {
  localStorage.setItem(STORAGE_KEY, key);
}

export function clearApiKey() {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Core fetch wrapper — always injects the auth header and throws on non-2xx.
 * @param {string} path  — relative path like "/api/devices"
 * @param {RequestInit} options — standard fetch options
 * @returns {Promise<any>} parsed JSON body
 */
async function request(path, options = {}) {
  const key = getApiKey();
  const headers = new Headers(options.headers || {});
  if (key) headers.set('Authorization', `Bearer ${key}`);
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.detail || j.message || msg; } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res;
}

export const api = {
  get: (path, params) => {
    const url = params ? `${path}?${new URLSearchParams(params)}` : path;
    return request(url, { method: 'GET' });
  },
  post: (path, body) => request(path, { method: 'POST', body }),
  postForm: (path, formData) => request(path, { method: 'POST', body: formData }),
  delete: (path) => request(path, { method: 'DELETE' }),
};
