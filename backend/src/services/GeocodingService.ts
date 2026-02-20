/**
 * GeocodingService v1.0.0
 *
 * Google Maps Geocoding integration for HustleXP.
 * Converts addresses to coordinates and vice versa,
 * and calculates distances between points using the Haversine formula.
 *
 * Uses Redis caching for geocoding results since addresses rarely change.
 *
 * @see https://developers.google.com/maps/documentation/geocoding
 */

import { config } from '../config';
import { redis } from '../cache/redis';
import { googleMapsBreaker } from '../middleware/circuit-breaker';
import { logger } from '../logger';

const log = logger.child({ service: 'GeocodingService' });

// Cache TTL: 30 days (geocoded addresses rarely change)
const GEOCODE_CACHE_TTL = 30 * 24 * 60 * 60;

// Cache key helpers
const CACHE_KEYS = {
  geocode: (address: string) => `geocode:addr:${address.toLowerCase().trim()}`,
  reverseGeocode: (lat: number, lng: number) =>
    `geocode:rev:${lat.toFixed(6)},${lng.toFixed(6)}`,
};

// ============================================================================
// GEOCODING
// ============================================================================

/**
 * Forward geocode: convert an address string to lat/lng coordinates.
 *
 * Results are cached in Redis for 30 days since addresses rarely change.
 * Returns null if the API key is missing, the address cannot be geocoded,
 * or the API call fails.
 */
export async function geocodeAddress(
  address: string
): Promise<{ lat: number; lng: number } | null> {
  const apiKey = config.googleMaps.apiKey;
  if (!apiKey) {
    log.warn('GOOGLE_MAPS_API_KEY is not configured, skipping geocode');
    return null;
  }

  if (!address || !address.trim()) {
    return null;
  }

  // Check cache first
  const cacheKey = CACHE_KEYS.geocode(address);
  try {
    const cached = await redis.get<{ lat: number; lng: number }>(cacheKey);
    if (cached) {
      return cached;
    }
  } catch {
    // Cache miss or error - proceed with API call
  }

  // Call Google Maps Geocoding API
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const response = await googleMapsBreaker.execute(() => fetch(url));

    if (!response.ok) {
      log.error({ httpStatus: response.status }, 'Geocode API returned error');
      return null;
    }

    const data = await response.json() as {
      status: string;
      results: Array<{
        geometry: {
          location: { lat: number; lng: number };
        };
      }>;
    };

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      log.warn({ address, status: data.status }, 'Geocode failed for address');
      return null;
    }

    const location = data.results[0].geometry.location;
    const result = { lat: location.lat, lng: location.lng };

    // Cache the result
    try {
      await redis.set(cacheKey, result, GEOCODE_CACHE_TTL);
    } catch {
      // Non-critical: caching failure should not break geocoding
    }

    return result;
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'Geocode API call failed');
    return null;
  }
}

/**
 * Reverse geocode: convert lat/lng coordinates to a formatted address string.
 *
 * Results are cached in Redis for 30 days.
 * Returns null if the API key is missing, the coordinates cannot be resolved,
 * or the API call fails.
 */
export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<string | null> {
  const apiKey = config.googleMaps.apiKey;
  if (!apiKey) {
    log.warn('GOOGLE_MAPS_API_KEY is not configured, skipping reverse geocode');
    return null;
  }

  // Check cache first
  const cacheKey = CACHE_KEYS.reverseGeocode(lat, lng);
  try {
    const cached = await redis.get<string>(cacheKey);
    if (cached) {
      return cached;
    }
  } catch {
    // Cache miss or error - proceed with API call
  }

  // Call Google Maps Geocoding API (reverse)
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
    const response = await googleMapsBreaker.execute(() => fetch(url));

    if (!response.ok) {
      log.error({ httpStatus: response.status }, 'Reverse geocode API returned error');
      return null;
    }

    const data = await response.json() as {
      status: string;
      results: Array<{
        formatted_address: string;
      }>;
    };

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      log.warn({ lat, lng, status: data.status }, 'Reverse geocode failed');
      return null;
    }

    const formattedAddress = data.results[0].formatted_address;

    // Cache the result
    try {
      await redis.set(cacheKey, formattedAddress, GEOCODE_CACHE_TTL);
    } catch {
      // Non-critical: caching failure should not break geocoding
    }

    return formattedAddress;
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'Reverse geocode API call failed');
    return null;
  }
}

// ============================================================================
// DISTANCE CALCULATION
// ============================================================================

/**
 * Calculate the distance in miles between two geographic points
 * using the Haversine formula.
 *
 * This is a pure math function - no API calls or caching needed.
 */
export function calculateDistanceMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 3959; // Earth's radius in miles
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

// ============================================================================
// EXPORTED SERVICE OBJECT
// ============================================================================

export const GeocodingService = {
  geocodeAddress,
  reverseGeocode,
  calculateDistanceMiles,
};

export default GeocodingService;
