/**
 * City Service - Phase E
 *
 * Multi-city configuration:
 * - City and zone resolution from coordinates
 * - Seattle seed data with 12 zones
 * - Config-driven instead of hardcoded
 */
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
declare class CityServiceClass {
    /**
     * Resolve city and zone from GPS coordinates
     */
    resolveCityFromLatLng(lat: number, lng: number): LocationResult;
    /**
     * Check if coordinates are within bounds
     */
    private isInBounds;
    /**
     * Get all active cities
     */
    getActiveCities(): City[];
    /**
     * Get city by ID or slug
     */
    getCity(idOrSlug: string): City | undefined;
    /**
     * Get city by ID
     */
    getCityById(cityId: string): City | undefined;
    /**
     * Get city by slug
     */
    getCityBySlug(slug: string): City | undefined;
    /**
     * Get zones for a city
     */
    getZonesForCity(cityIdOrSlug: string): Zone[];
    /**
     * Get zone by ID
     */
    getZone(zoneId: string): Zone | undefined;
    /**
     * Get zone by city and slug
     */
    getZoneBySlug(cityId: string, zoneSlug: string): Zone | undefined;
    /**
     * Get zone name from slug (for display)
     */
    getZoneName(zoneSlug: string, cityId?: string): string;
    /**
     * Add a new city
     */
    addCity(cityData: Omit<City, 'id' | 'createdAt' | 'updatedAt'>): City;
    /**
     * Add a zone to a city
     */
    addZone(zoneData: Omit<Zone, 'id' | 'createdAt' | 'updatedAt'>): Zone;
    /**
     * Get coverage stats
     */
    getCoverageStats(): {
        cities: number;
        activeCities: number;
        totalZones: number;
        zonesByCity: {
            city: string;
            zones: number;
        }[];
    };
}
export declare const CityService: CityServiceClass;
export {};
//# sourceMappingURL=CityService.d.ts.map