/**
 * Hustler En Route Map Screen (MAX-TIER)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Screen ID: HUSTLER_EN_ROUTE_MAP
 * Spec Authority: Phase V1.3 — Maps Screens (EN_ROUTE Gated) (LOCKED)
 * Version: v1.0
 * Status: LOCKED
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. MAPS GATE (ARCHITECTURE §14.5):
 *    ✅ Maps are execution visualizations, not discovery surfaces
 *    ✅ Unlock Condition: task.state === 'ACCEPTED' (EN_ROUTE conceptually)
 *    ✅ No task list, no discovery — map only
 * 
 * 2. DISPLAY:
 *    - User current location (blue dot)
 *    - Task destination (red marker)
 *    - Route line (optional, requires routing API)
 *    - ETA display
 * 
 * 3. STATE GATED:
 *    - Only visible when task is in EN_ROUTE state (ACCEPTED in schema)
 *    - Navigation guards prevent access before EN_ROUTE
 * 
 * ============================================================================
 * COMPONENT DEPENDENCIES
 * ============================================================================
 * 
 * Required Components:
 * - MapView from react-native-maps
 * - GlassCard (hustlexp-app/ui/GlassCard.tsx)
 * 
 * Required Tokens:
 * - colors (hustlexp-app/ui/colors.ts)
 * - spacing (hustlexp-app/ui/spacing.ts)
 * 
 * ============================================================================
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import MapView, { Marker, Polyline } from 'react-native-maps';
import * as Location from 'expo-location';
import { colors } from '../../ui/colors';
import { spacing } from '../../ui/spacing';

interface HustlerEnRouteMapScreenProps {
  route: {
    params: {
      taskId: string;
    };
  };
  navigation: any;
}

interface LocationCoords {
  latitude: number;
  longitude: number;
}

/**
 * Hustler En Route Map Screen
 * 
 * Displays route to task destination with ETA.
 * Only accessible when task is in EN_ROUTE state (ACCEPTED).
 * 
 * Phase V1.3: Maps implementation (EN_ROUTE gated).
 */
export default function HustlerEnRouteMapScreen({ route, navigation }: HustlerEnRouteMapScreenProps) {
  const { taskId } = route.params;
  
  const [currentLocation, setCurrentLocation] = useState<LocationCoords | null>(null);
  const [destinationLocation, setDestinationLocation] = useState<LocationCoords | null>(null);
  const [eta, setEta] = useState<string>('Calculating...');
  const [hasLocationPermission, setHasLocationPermission] = useState<boolean>(false);
  const [isLoadingLocation, setIsLoadingLocation] = useState<boolean>(true);

  // TODO: Phase N2 — Get destination from task data (tasks.getState or tasks.get)
  // For V1.3, using mock destination coordinates
  const MOCK_DESTINATION = {
    latitude: 47.6062, // Seattle, WA
    longitude: -122.3321,
  };

  useEffect(() => {
    requestLocationPermission();
    // Set mock destination for V1.3
    setDestinationLocation(MOCK_DESTINATION);
  }, []);

  useEffect(() => {
    if (currentLocation && destinationLocation) {
      calculateETA();
    }
  }, [currentLocation, destinationLocation]);

  const requestLocationPermission = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        setHasLocationPermission(true);
        getCurrentLocation();
      } else {
        setHasLocationPermission(false);
        setIsLoadingLocation(false);
        // For V1.3, use mock location if permission denied
        setCurrentLocation({ latitude: 47.6097, longitude: -122.3331 });
        setIsLoadingLocation(false);
      }
    } catch (error) {
      console.error('Error requesting location permission:', error);
      setIsLoadingLocation(false);
    }
  };

  const getCurrentLocation = async () => {
    try {
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setCurrentLocation({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      });
      setIsLoadingLocation(false);
    } catch (error) {
      console.error('Error getting current location:', error);
      // Fallback to mock location for V1.3
      setCurrentLocation({ latitude: 47.6097, longitude: -122.3331 });
      setIsLoadingLocation(false);
    }
  };

  const calculateETA = () => {
    // TODO: Phase N2 — Real ETA calculation using routing API
    // For V1.3, use mock calculation
    if (currentLocation && destinationLocation) {
      // Simple distance-based mock ETA (not accurate, just for display)
      const mockETA = '~12 minutes';
      setEta(mockETA);
    }
  };

  // Calculate map region to show both locations
  const getMapRegion = () => {
    if (!currentLocation || !destinationLocation) {
      return {
        latitude: 47.6062,
        longitude: -122.3321,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      };
    }

    const minLat = Math.min(currentLocation.latitude, destinationLocation.latitude);
    const maxLat = Math.max(currentLocation.latitude, destinationLocation.latitude);
    const minLng = Math.min(currentLocation.longitude, destinationLocation.longitude);
    const maxLng = Math.max(currentLocation.longitude, destinationLocation.longitude);

    const latDelta = (maxLat - minLat) * 1.5 + 0.01;
    const lngDelta = (maxLng - minLng) * 1.5 + 0.01;

    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max(latDelta, 0.05),
      longitudeDelta: Math.max(lngDelta, 0.05),
    };
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <MaterialIcons name="arrow-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>En Route</Text>
        <View style={styles.backButton} />
      </View>

      {/* Map Container */}
      <View style={styles.mapContainer}>
        {isLoadingLocation ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.primaryAction} />
            <Text style={styles.loadingText}>Loading map...</Text>
          </View>
        ) : (
          <MapView
            style={styles.map}
            initialRegion={getMapRegion()}
            showsUserLocation={hasLocationPermission}
            showsMyLocationButton={false}
            followsUserLocation={false}
            mapType="standard"
          >
            {/* Current Location Marker (if permission granted) */}
            {currentLocation && (
              <Marker
                coordinate={currentLocation}
                title="Your Location"
                pinColor="#007AFF" // Blue for current location
              />
            )}

            {/* Destination Marker */}
            {destinationLocation && (
              <Marker
                coordinate={destinationLocation}
                title="Task Location"
                pinColor="#FF3B30" // Red for destination
              />
            )}

            {/* Route Line (optional - would require routing API) */}
            {/* For V1.3, we skip the route line as it requires external routing service */}
          </MapView>
        )}
      </View>

      {/* ETA Card */}
      <View style={styles.etaCard}>
        <View style={styles.etaContent}>
          <MaterialIcons name="access-time" size={20} color={colors.textPrimary} />
          <View style={styles.etaTextContainer}>
            <Text style={styles.etaLabel}>Estimated Arrival</Text>
            <Text style={styles.etaValue}>{eta}</Text>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.card,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.glassBorderSecondary,
  },
  backButton: {
    width: 40,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  mapContainer: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: colors.textSecondary,
  },
  etaCard: {
    position: 'absolute',
    bottom: 32,
    left: spacing.card,
    right: spacing.card,
    backgroundColor: colors.glassPrimary,
    borderWidth: 1,
    borderColor: colors.glassBorderPrimary,
    borderRadius: 16,
    padding: spacing.card,
  },
  etaContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  etaTextContainer: {
    flex: 1,
  },
  etaLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: 4,
  },
  etaValue: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
  },
});
