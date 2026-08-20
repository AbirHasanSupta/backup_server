import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_PREFIX = 'geocode_cache_v1:';
const REQUEST_MIN_INTERVAL_MS = 1100;

let lastRequestAt = 0;
const inFlight = new Map<string, Promise<string | null>>();

function roundKey(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

function pickLabel(address: Record<string, string> | undefined, displayName: string | undefined): string | null {
  if (address) {
    const area = address.neighbourhood || address.suburb || address.quarter || address.residential || address.hamlet || address.village;
    const district = address.city_district || address.town || address.city || address.county || address.state_district;
    if (area && district && area !== district) return `${area}, ${district}`;
    if (area) return area;
    if (district) return district;
    const region = address.state || address.country;
    if (region) return region;
  }
  if (displayName) {
    const parts = displayName.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`;
    if (parts.length === 1) return parts[0];
  }
  return null;
}

async function throttle(): Promise<void> {
  const wait = REQUEST_MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function fetchPlaceName(lat: number, lon: number): Promise<string | null> {
  await throttle();
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'PhoneBackupApp/1.0', 'Accept-Language': 'en' } });
  if (!res.ok) return null;
  const data = await res.json();
  return pickLabel(data?.address, data?.display_name);
}

export async function getPlaceName(lat?: number, lon?: number): Promise<string | null> {
  if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return null;
  const key = roundKey(lat, lon);
  const cacheKey = CACHE_PREFIX + key;

  try {
    const cached = await AsyncStorage.getItem(cacheKey);
    if (cached != null) return cached || null;
  } catch {
    // Ignore cache read errors and fall through to network.
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const name = await fetchPlaceName(lat, lon);
      await AsyncStorage.setItem(cacheKey, name || '').catch(() => {});
      return name;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}