/**
 * City Service - Phase E
 * 
 * Multi-city configuration:
 * - City and zone resolution from coordinates
 * - Seattle seed data with 12 zones
 * - Config-driven instead of hardcoded
 */

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';

// ============================================
// Types
// ============================================

export interface City {
    id: string;
    slug: string;
    name: string;
    active: boolean;
    defaultTimezone: string;
    bounds: {
        north: number;
        south: number;
        east: number;
        west: number;
    };
    createdAt: Date;
    updatedAt: Date;
}

export interface Zone {
    id: string;
    cityId: string;
    slug: string;
    name: string;
    bounds: {
        north: number;
        south: number;
        east: number;
        west: number;
    };
    isDowntown: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface LocationResult {
    city: City | null;
    zone: Zone | null;
    inCoverage: boolean;
}

// ============================================
// Seattle Seed Data
// ============================================

const SEATTLE_CITY: City = {
    id: 'city_seattle',
    slug: 'seattle',
    name: 'Seattle',
    active: true,
    defaultTimezone: 'America/Los_Angeles',
    bounds: {
        north: 47.7341,
        south: 47.4919,
        east: -122.2244,
        west: -122.4596,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
};

const SEATTLE_ZONES: Zone[] = [
    { id: 'zone_capitol_hill', cityId: 'city_seattle', slug: 'capitol_hill', name: 'Capitol Hill', bounds: { north: 47.635, south: 47.615, east: -122.305, west: -122.325 }, isDowntown: false, createdAt: new Date(), updatedAt: new Date() },
    { id: 'zone_ballard', cityId: 'city_seattle', slug: 'ballard', name: 'Ballard', bounds: { north: 47.69, south: 47.66, east: -122.36, west: -122.40 }, isDowntown: false, createdAt: new Date(), updatedAt: new Date() },
    { id: 'zone_fremont', cityId: 'city_seattle', slug: 'fremont', name: 'Fremont', bounds: { north: 47.665, south: 47.648, east: -122.345, west: -122.365 }, isDowntown: false, createdAt: new Date(), updatedAt: new Date() },
    { id: 'zone_university_district', cityId: 'city_seattle', slug: 'university_district', name: 'University District', bounds: { north: 47.675, south: 47.655, east: -122.295, west: -122.325 }, isDowntown: false, createdAt: new Date(), updatedAt: new Date() },
    { id: 'zone_queen_anne', cityId: 'city_seattle', slug: 'queen_anne', name: 'Queen Anne', bounds: { north: 47.645, south: 47.625, east: -122.345, west: -122.365 }, isDowntown: false, createdAt: new Date(), updatedAt: new Date() },
    { id: 'zone_downtown', cityId: 'city_seattle', slug: 'downtown', name: 'Downtown', bounds: { north: 47.620, south: 47.600, east: -122.325, west: -122.345 }, isDowntown: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 'zone_south_lake_union', cityId: 'city_seattle', slug: 'south_lake_union', name: 'South Lake Union', bounds: { north: 47.635, south: 47.620, east: -122.330, west: -122.345 }, isDowntown: true, createdAt: new Date(), updatedAt: new Date() },
    { id: 'zone_beacon_hill', cityId: 'city_seattle', slug: 'beacon_hill', name: 'Beacon Hill', bounds: { north: 47.590, south: 47.565, east: -122.295, west: -122.315 }, isDowntown: false, createdAt: new Date(), updatedAt: new Date() },
    { id: 'zone_columbia_city', cityId: 'city_seattle', slug: 'columbia_city', name: 'Columbia City', bounds: { north: 47.570, south: 47.555, east: -122.275, west: -122.295 }, isDowntown: false, createdAt: new Date(), updatedAt: new Date() },
    { id: 'zone_west_seattle', cityId: 'city_seattle', slug: 'west_seattle', name: 'West Seattle', bounds: { north: 47.580, south: 47.545, east: -122.365, west: -122.405 }, isDowntown: false, createdAt: new Date(), updatedAt: new Date() },
    { id: 'zone_greenwood', cityId: 'city_seattle', slug: 'greenwood', name: 'Greenwood', bounds: { north: 47.710, south: 47.690, east: -122.345, west: -122.365 }, isDowntown: false, createdAt: new Date(), updatedAt: new Date() },
    { id: 'zone_wallingford', cityId: 'city_seattle', slug: 'wallingford', name: 'Wallingford', bounds: { north: 47.665, south: 47.650, east: -122.325, west: -122.345 }, isDowntown: false, createdAt: new Date(), updatedAt: new Date() },
];

// ============================================
// In-memory store (syncs to DB)
// ============================================

const cities = new Map<string, City>();
const zones = new Map<string, Zone>();
const zonesByCity = new Map<string, Zone[]>();

// Initialize with Seattle data
cities.set(SEATTLE_CITY.id, SEATTLE_CITY);
cities.set(SEATTLE_CITY.slug, SEATTLE_CITY);

for (const zone of SEATTLE_ZONES) {
    zones.set(zone.id, zone);
    zones.set(`${zone.cityId}:${zone.slug}`, zone);
}
zonesByCity.set(SEATTLE_CITY.id, SEATTLE_ZONES);

// ============================================
// Service Class
// ============================================

class CityServiceClass {
    // ============================================
    // City Resolution
    // ============================================

    /**
     * Resolve city and zone from GPS coordinates
     */
    resolveCityFromLatLng(lat: number, lng: number): LocationResult {
        // Check each city
        for (const city of cities.values()) {
            if (city.slug === city.id) continue; // Skip duplicate entries

            if (this.isInBounds(lat, lng, city.bounds)) {
                // Found city, now find zone
                const cityZones = zonesByCity.get(city.id) || [];

                for (const zone of cityZones) {
                    if (this.isInBounds(lat, lng, zone.bounds)) {
                        return { city, zone, inCoverage: true };
                    }
                }

                // In city but not in specific zone
                return { city, zone: null, inCoverage: true };
            }
        }

        return { city: null, zone: null, inCoverage: false };
    }

    /**
     * Check if coordinates are within bounds
     */
    private isInBounds(
        lat: number,
        lng: number,
        bounds: { north: number; south: number; east: number; west: number }
    ): boolean {
        return (
            lat >= bounds.south &&
            lat <= bounds.north &&
            lng >= bounds.west &&
            lng <= bounds.east
        );
    }

    // ============================================
    // City Queries
    // ============================================

    /**
     * Get all active cities
     */
    getActiveCities(): City[] {
        const result: City[] = [];
        const seen = new Set<string>();

        for (const city of cities.values()) {
            if (city.active && !seen.has(city.id)) {
                result.push(city);
                seen.add(city.id);
            }
        }

        return result;
    }

    /**
     * Get city by ID or slug
     */
    getCity(idOrSlug: string): City | undefined {
        return cities.get(idOrSlug);
    }

    /**
     * Get city by ID
     */
    getCityById(cityId: string): City | undefined {
        return cities.get(cityId);
    }

    /**
     * Get city by slug
     */
    getCityBySlug(slug: string): City | undefined {
        for (const city of cities.values()) {
            if (city.slug === slug) {
                return city;
            }
        }
        return undefined;
    }

    // ============================================
    // Zone Queries
    // ============================================

    /**
     * Get zones for a city
     */
    getZonesForCity(cityIdOrSlug: string): Zone[] {
        const city = this.getCity(cityIdOrSlug);
        if (!city) return [];

        return zonesByCity.get(city.id) || [];
    }

    /**
     * Get zone by ID
     */
    getZone(zoneId: string): Zone | undefined {
        return zones.get(zoneId);
    }

    /**
     * Get zone by city and slug
     */
    getZoneBySlug(cityId: string, zoneSlug: string): Zone | undefined {
        return zones.get(`${cityId}:${zoneSlug}`);
    }

    /**
     * Get zone name from slug (for display)
     */
    getZoneName(zoneSlug: string, cityId: string = 'city_seattle'): string {
        const zone = this.getZoneBySlug(cityId, zoneSlug);
        return zone?.name || zoneSlug;
    }

    // ============================================
    // City Management (for future admin use)
    // ============================================

    /**
     * Add a new city
     */
    addCity(cityData: Omit<City, 'id' | 'createdAt' | 'updatedAt'>): City {
        const city: City = {
            id: `city_${uuidv4()}`,
            ...cityData,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        cities.set(city.id, city);
        cities.set(city.slug, city);
        zonesByCity.set(city.id, []);

        serviceLogger.info({ cityId: city.id, slug: city.slug }, 'City added');
        return city;
    }

    /**
     * Add a zone to a city
     */
    addZone(zoneData: Omit<Zone, 'id' | 'createdAt' | 'updatedAt'>): Zone {
        const zone: Zone = {
            id: `zone_${uuidv4()}`,
            ...zoneData,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        zones.set(zone.id, zone);
        zones.set(`${zone.cityId}:${zone.slug}`, zone);

        const cityZones = zonesByCity.get(zone.cityId) || [];
        cityZones.push(zone);
        zonesByCity.set(zone.cityId, cityZones);

        serviceLogger.info({ zoneId: zone.id, cityId: zone.cityId }, 'Zone added');
        return zone;
    }

    // ============================================
    // Stats
    // ============================================

    /**
     * Get coverage stats
     */
    getCoverageStats(): {
        cities: number;
        activeCities: number;
        totalZones: number;
        zonesByCity: { city: string; zones: number }[];
    } {
        const activeCities = this.getActiveCities();
        const zoneStats = activeCities.map(city => ({
            city: city.name,
            zones: (zonesByCity.get(city.id) || []).length,
        }));

        return {
            cities: activeCities.length,
            activeCities: activeCities.filter(c => c.active).length,
            totalZones: Array.from(zones.values()).filter((z, i, arr) =>
                arr.findIndex(x => x.id === z.id) === i
            ).length,
            zonesByCity: zoneStats,
        };
    }
}

export const CityService = new CityServiceClass();
