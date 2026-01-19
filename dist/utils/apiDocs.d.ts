/**
 * API Documentation Generator - Phase F
 *
 * Generates structured API documentation for mobile app integration
 */
export interface EndpointDoc {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    path: string;
    description: string;
    auth: 'public' | 'optionalAuth' | 'requireAuth' | 'requireRole';
    role?: string;
    requestSchema?: Record<string, unknown>;
    responseSchema?: Record<string, unknown>;
    tags: string[];
}
/**
 * Get full API documentation
 */
export declare function getAPIDocs(): {
    version: string;
    baseUrl: string;
    endpoints: EndpointDoc[];
    tags: string[];
};
/**
 * Get endpoints by tag
 */
export declare function getEndpointsByTag(tag: string): EndpointDoc[];
/**
 * Get sample endpoint for documentation
 */
export declare function getSampleEndpoint(): EndpointDoc;
//# sourceMappingURL=apiDocs.d.ts.map