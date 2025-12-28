import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import {
  RoutingMode,
  Avoidances,
  LatLng,
  RouteResponse,
  AppStatus
} from './types';
import { calculateRoute } from './services/routingEngine';
import { MANEUVER_ICONS } from './constants';
import { searchNominatim, reverseNominatim } from './services/geocoding';
import { parseGPX } from './services/gpxParser';

const MODE_LABELS: Record<RoutingMode, { label: string; icon: string; desc: string }> = {
  [RoutingMode.FAST]: { label: 'Fast', icon: '⚡', desc: 'Direct & efficient' },
  [RoutingMode.BALANCED]: { label: 'Balanced', icon: '⚖️', desc: 'Flowing & safe' },
  [RoutingMode.CURVY]: { label: 'Curvy', icon: '↪️', desc: 'Seek the bends' },
};

interface StopInput {
  address: string;
  coord: LatLng | null;
  id: string;
}

interface Suggestion {
  display_name: string;
  lat: string;
  lon: string;
  address?: {
    country_code?: string;
    city?: string;
    town?: string;
    village?: string;
  };
}

const PROTOMAPS_ATTRIBUTION =
  '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>';

const buildBaseMapStyle = (pmtilesUrl: string) => ({
  version: 8,
  glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
  sources: {
    protomaps: {
      type: 'vector',
      url: `pmtiles://${pmtilesUrl}`,
      attribution: PROTOMAPS_ATTRIBUTION
    }
  },
  layers: layers('protomaps', namedFlavor('light'), { lang: 'en' })
});

const App: React.FC = () => {
  const LOOKAHEAD_BASE_METERS = 25;
  const [appStatus, setAppStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [baseMapPmtilesUrl, setBaseMapPmtilesUrl] = useState<string>('');
  const [selectedMode, setSelectedMode] = useState<RoutingMode>(RoutingMode.BALANCED);
  const [optimizeOrder, setOptimizeOrder] = useState(false);

  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const waypointPopupRef = useRef<maplibregl.Popup | null>(null);
  const pmtilesProtocolRef = useRef<Protocol | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const waypointMarkersRef = useRef<maplibregl.Marker[]>([]);

  // Performance: Refs for throttling state updates to prevent excessive re-renders
  const lastStateUpdateTimeRef = useRef<number>(0);
  const pendingPosRef = useRef<LatLng | null>(null);
  const pendingHeadingRef = useRef<number | null>(null);
  const pendingSpeedRef = useRef<number | null>(null);
  const currentSegmentIndexRef = useRef<number>(-1);
  const lastRouteVisualPosRef = useRef<LatLng | null>(null);
  const polylineDistancesRef = useRef<number[] | null>(null);
  const currentManeuverIndexRef = useRef<number>(0);
  const currentManeuverRemainingRef = useRef<number | null>(null);
  const maneuverMetaRef = useRef<Array<{ distanceAlong: number; polylineIndex: number; postBearing: number; roadName: string | null; location: LatLng | null }>>([]);
  const offRouteCounterRef = useRef<number>(0);
  const lastRerouteTimeRef = useRef<number>(0);
  const reroutingRef = useRef<boolean>(false);
  const debugNavRef = useRef<boolean>(false);
  const lastMapViewUpdateTimeRef = useRef<number>(0);
  const smoothedHeadingRef = useRef<number>(0);
  const mapBearingRef = useRef<number>(0);

  const [stops, setStops] = useState<StopInput[]>([
    { address: 'My Location', coord: null, id: 'start' },
    { address: '', coord: null, id: 'end' }
  ]);

  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [currentPos, setCurrentPos] = useState<LatLng | null>(null);
  const [heading, setHeading] = useState<number>(0);
  const [speed, setSpeed] = useState<number>(0);
  const [isFollowing, setIsFollowing] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(13);
  const [gpsActive, setGpsActive] = useState(false);
  const [gpsPermissionDenied, setGpsPermissionDenied] = useState(false);
  const [userCountry, setUserCountry] = useState<string | null>(null);
  const [isUIVisible, setIsUIVisible] = useState(true);
  const [gpxLoading, setGpxLoading] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const simIntervalRef = useRef<number | null>(null);
  const distanceRef = useRef(0);
  const [currentManeuverIndex, setCurrentManeuverIndex] = useState(0);
  const [currentManeuverRemaining, setCurrentManeuverRemaining] = useState<number | null>(null);
  const simLastTimeRef = useRef<number | null>(null);
  const simLastDistRef = useRef<number>(0);

  const [isPortrait, setIsPortrait] = useState(window.innerHeight > window.innerWidth);
  useEffect(() => {
    const handleResize = () => {
      setIsPortrait(window.innerHeight > window.innerWidth);
      mapRef.current?.resize();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    debugNavRef.current = window.localStorage?.getItem('debugNav') === '1';
  }, []);

  useEffect(() => {
    if (baseMapPmtilesUrl) return;
    fetch('https://build-metadata.protomaps.dev/builds.json')
      .then(res => res.json())
      .then((builds: Array<{ key: string }>) => {
        const latest = builds.sort((a, b) => (a.key < b.key ? 1 : -1))[0];
        if (latest?.key) {
          setBaseMapPmtilesUrl(`https://build.protomaps.com/${latest.key}`);
        }
      })
      .catch(() => {
        setBaseMapPmtilesUrl('https://build.protomaps.com/20240101.pmtiles');
      });
  }, [baseMapPmtilesUrl]);

  // Reverse-geocode to detect user's country when position is first available
  useEffect(() => {
    if (currentPos && !userCountry) {
      reverseNominatim(currentPos).then(result => {
        if (result && result.countryCode) {
          setUserCountry(result.countryCode);
          console.log('Detected country:', result.countryCode);
        }
      });
    }
  }, [currentPos, userCountry]);

  const lastPosRef = useRef<LatLng | null>(null);
  const isFollowingRef = useRef(isFollowing);
  const zoomLevelRef = useRef(zoomLevel);
  const appStatusRef = useRef(appStatus);
  const routeRef = useRef(route);

  useEffect(() => { isFollowingRef.current = isFollowing; }, [isFollowing]);
  useEffect(() => { zoomLevelRef.current = zoomLevel; }, [zoomLevel]);
  useEffect(() => { appStatusRef.current = appStatus; }, [appStatus]);
  useEffect(() => { routeRef.current = route; }, [route]);
  useEffect(() => { currentManeuverIndexRef.current = currentManeuverIndex; }, [currentManeuverIndex]);
  useEffect(() => {
    if (route?.polyline?.length) {
      const distances: number[] = [0];
      for (let i = 1; i < route.polyline.length; i++) {
        distances.push(distances[i - 1] + getDistanceMeters(route.polyline[i - 1], route.polyline[i]));
      }
      polylineDistancesRef.current = distances;
      maneuverMetaRef.current = buildManeuverMeta(route, distances);
    } else {
      polylineDistancesRef.current = null;
      maneuverMetaRef.current = [];
    }
    currentManeuverIndexRef.current = 0;
    setCurrentManeuverIndex(0);
    currentManeuverRemainingRef.current = null;
    setCurrentManeuverRemaining(null);
  }, [route]);

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState<number | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const getDistance = (p1: LatLng, p2: LatLng) => {
    return Math.sqrt(Math.pow(p2.lat - p1.lat, 2) + Math.pow(p2.lng - p1.lng, 2));
  };

  const getDistanceMeters = (p1: LatLng, p2: LatLng) => {
    const R = 6371000;
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const lat1 = p1.lat * Math.PI / 180;
    const lat2 = p2.lat * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const getBearingDelta = (a: number, b: number) => {
    let diff = Math.abs(a - b) % 360;
    if (diff > 180) diff = 360 - diff;
    return diff;
  };

  const getAdvanceThreshold = (speedKmh: number) => {
    if (speedKmh <= 10) return 20;
    if (speedKmh <= 30) return 30;
    if (speedKmh <= 60) return 50;
    return 80;
  };

  const getBearingThreshold = (speedKmh: number) => {
    if (speedKmh <= 10) return 70;
    if (speedKmh <= 30) return 55;
    if (speedKmh <= 60) return 45;
    return 35;
  };

  const getOffRouteThreshold = (speedKmh: number) => {
    if (speedKmh <= 10) return 25;
    if (speedKmh <= 30) return 35;
    if (speedKmh <= 60) return 55;
    return 80;
  };

  const findClosestPolylineIndex = (point: LatLng, line: LatLng[]) => {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < line.length; i++) {
      const d = getDistance(line[i], point);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    }
    return bestIndex;
  };

  const findPolylineIndexByDistance = (distances: number[], target: number) => {
    for (let i = 0; i < distances.length; i++) {
      if (distances[i] >= target) return Math.max(0, i - 1);
    }
    return Math.max(0, distances.length - 1);
  };

  const buildManeuverMeta = (routeData: RouteResponse, distances: number[]) => {
    if (!routeData.maneuvers?.length || distances.length < 2) return [];
    const totalPolylineDist = distances[distances.length - 1] || 0;
    const scale = routeData.distance > 0 ? totalPolylineDist / routeData.distance : 1;
    let cumulativeStepDist = 0;
    const meta: Array<{ distanceAlong: number; polylineIndex: number; postBearing: number; roadName: string | null; location: LatLng | null }> = [];
    for (let i = 0; i < routeData.maneuvers.length; i++) {
      const maneuver = routeData.maneuvers[i];
      const stepDist = maneuver.distance || 0;
      let distanceAlong = cumulativeStepDist * scale;
      cumulativeStepDist += stepDist;

      let polylineIndex = 0;
      if (maneuver.location) {
        polylineIndex = findClosestPolylineIndex(maneuver.location, routeData.polyline);
        distanceAlong = distances[polylineIndex] ?? distanceAlong;
      } else {
        polylineIndex = findPolylineIndexByDistance(distances, distanceAlong);
      }

      const prev = meta[i - 1];
      if (prev && distanceAlong < prev.distanceAlong) {
        distanceAlong = prev.distanceAlong;
      }

      const nextIndex = Math.min(routeData.polyline.length - 1, polylineIndex + 1);
      const postBearing = calculateBearing(routeData.polyline[polylineIndex], routeData.polyline[nextIndex]);

      meta.push({
        distanceAlong,
        polylineIndex,
        postBearing,
        roadName: maneuver.roadName || null,
        location: maneuver.location || routeData.polyline[polylineIndex]
      });
    }
    return meta;
  };

  const interpolate = (p1: LatLng, p2: LatLng, fraction: number): LatLng => {
    return {
      lat: p1.lat + (p2.lat - p1.lat) * fraction,
      lng: p1.lng + (p2.lng - p1.lng) * fraction
    };
  };

  const calculateBearing = (start: LatLng, end: LatLng) => {
    const dy = end.lat - start.lat;
    const dx = Math.cos(Math.PI / 180 * start.lat) * (end.lng - start.lng);
    const angle = Math.atan2(dx, dy) * 180 / Math.PI;
    return (angle + 360) % 360;
  };

  const smoothAngle = (current: number, target: number, factor: number) => {
    let diff = target - current;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return (current + diff * factor + 360) % 360;
  };

  const getLookaheadBearing = (
    routeData: RouteResponse,
    segmentIndex: number,
    pos: LatLng,
    lookaheadMeters: number
  ) => {
    const distances = polylineDistancesRef.current;
    if (!distances || distances.length < 2 || routeData.distance <= 0) return null;

    const totalUnits = distances[distances.length - 1];
    if (!totalUnits) return null;

    const segIdx = Math.max(0, Math.min(segmentIndex, routeData.polyline.length - 1));
    const segStart = routeData.polyline[segIdx];
    const progressUnits = distances[segIdx] + getDistanceMeters(segStart, pos);
    const lookaheadUnits = lookaheadMeters;
    let targetUnits = Math.min(totalUnits, progressUnits + lookaheadUnits);
    if (targetUnits <= progressUnits && progressUnits < totalUnits) {
      targetUnits = Math.min(totalUnits, progressUnits + totalUnits * 0.001);
    }

    let targetIndex = -1;
    for (let i = segIdx; i < distances.length; i++) {
      if (distances[i] >= targetUnits) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex === -1) targetIndex = distances.length - 1;

    const prevIndex = Math.max(0, targetIndex - 1);
    const segLen = distances[targetIndex] - distances[prevIndex];
    const frac = segLen > 0 ? (targetUnits - distances[prevIndex]) / segLen : 0;
    const targetPoint = interpolate(routeData.polyline[prevIndex], routeData.polyline[targetIndex], frac);
    return calculateBearing(pos, targetPoint);
  };

  const getNearestPointOnLine = (p: LatLng, line: LatLng[]) => {
    let minDistance = Infinity;
    let nearestPoint = p;
    let bearing = 0;
    let segmentIndex = 0;

    for (let i = 0; i < line.length - 1; i++) {
      const start = line[i];
      const end = line[i + 1];
      const dx = end.lng - start.lng;
      const dy = end.lat - start.lat;
      if (dx === 0 && dy === 0) continue;

      const t = ((p.lng - start.lng) * dx + (p.lat - start.lat) * dy) / (dx * dx + dy * dy);
      const clampedT = Math.max(0, Math.min(1, t));
      const projP = { lat: start.lat + clampedT * dy, lng: start.lng + clampedT * dx };
      const dist = getDistance(p, projP);

      if (dist < minDistance) {
        minDistance = dist;
        nearestPoint = projP;
        bearing = calculateBearing(start, end);
        segmentIndex = i;
      }
    }
    return { point: nearestPoint, bearing, segmentIndex };
  };

  const buildLineFeature = (points: LatLng[]) => ({
    type: 'FeatureCollection' as const,
    features: points.length >= 2
      ? [{
        type: 'Feature' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: points.map(p => [p.lng, p.lat])
        },
        properties: {}
      }]
      : []
  });

  const updateRouteVisuals = useCallback((targetPos: LatLng, polyline: LatLng[], segIdx: number) => {
    if (!mapRef.current || !mapLoaded) return;

    // Performance: Only update if segment changed or rider moved a meaningful amount
    if (currentSegmentIndexRef.current === segIdx) {
      if (lastRouteVisualPosRef.current && getDistance(lastRouteVisualPosRef.current, targetPos) < 0.00003) {
        return;
      }
    }
    currentSegmentIndexRef.current = segIdx;
    lastRouteVisualPosRef.current = targetPos;

    const behindPoints = [...polyline.slice(0, segIdx + 1), targetPos];
    const aheadPoints = [targetPos, ...polyline.slice(segIdx + 1)];

    const map = mapRef.current;
    const behindSourceId = 'route-behind';
    const aheadSourceId = 'route-ahead';
    const behindLayerId = 'route-behind-line';
    const aheadLayerId = 'route-ahead-line';

    // 1. Ensure Sources Exist
    if (!map.getSource(behindSourceId)) {
      map.addSource(behindSourceId, { type: 'geojson', data: buildLineFeature([]) });
    }
    if (!map.getSource(aheadSourceId)) {
      map.addSource(aheadSourceId, { type: 'geojson', data: buildLineFeature([]) });
    }

    // 2. Ensure Layers Exist (even if source existed)
    if (!map.getLayer(behindLayerId)) {
      map.addLayer({
        id: behindLayerId,
        type: 'line',
        source: behindSourceId,
        paint: {
          'line-color': '#3b82f6',
          'line-width': 8,
          'line-opacity': 0.15
        },
        layout: { 'line-join': 'round', 'line-cap': 'round' }
      });
    }

    if (!map.getLayer(aheadLayerId)) {
      map.addLayer({
        id: aheadLayerId,
        type: 'line',
        source: aheadSourceId,
        paint: {
          'line-color': '#3b82f6',
          'line-width': 8,
          'line-opacity': 0.85
        },
        layout: { 'line-join': 'round', 'line-cap': 'round' }
      });
    }

    const behindSource = map.getSource(behindSourceId) as maplibregl.GeoJSONSource | undefined;
    const aheadSource = map.getSource(aheadSourceId) as maplibregl.GeoJSONSource | undefined;

    // Safely update data (check for >1 points implicitly handled by buildLineFeature returning empty checks)
    if (behindSource) behindSource.setData(buildLineFeature(behindPoints));
    if (aheadSource) aheadSource.setData(buildLineFeature(aheadPoints));
  }, [mapLoaded]);

  const updateWaypointMarkers = useCallback(() => {
    if (!mapRef.current) return;

    waypointMarkersRef.current.forEach(marker => {
      if (marker) marker.remove();
    });
    waypointMarkersRef.current = [];

    stops.forEach((stop, index) => {
      if (!stop.coord) return;

      const label = index === 0 ? 'A' : index === stops.length - 1 ? 'B' : index.toString();
      const isFirst = index === 0;
      const isLast = index === stops.length - 1;
      const canRemove = !isFirst && !isLast && stops.length > 2;

      const markerEl = document.createElement('div');
      markerEl.innerHTML = `<div style="width: 32px; height: 32px; background: ${isFirst ? '#10b981' : isLast ? '#ef4444' : '#3b82f6'}; border: 3px solid white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 900; color: white; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); ${canRemove ? 'cursor: pointer;' : ''}">${label}</div>`;
      const marker = new maplibregl.Marker({ element: markerEl, anchor: 'center' })
        .setLngLat([stop.coord.lng, stop.coord.lat])
        .addTo(mapRef.current);

      // Make intermediate waypoints clickable to show action menu
      if (canRemove) {
        markerEl.addEventListener('click', () => {
          const popupContent = `
            <div style="padding: 4px;">
              <button 
                onclick="window.removeWaypoint(${index})"
                style="
                  width: 100%;
                  padding: 8px 16px;
                  background: #ef4444;
                  color: white;
                  border: none;
                  border-radius: 8px;
                  font-weight: 700;
                  font-size: 12px;
                  cursor: pointer;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  gap: 6px;
                  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                "
                onmouseover="this.style.background='#dc2626'"
                onmouseout="this.style.background='#ef4444'"
              >
                <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete Waypoint
              </button>
            </div>
          `;

          if (waypointPopupRef.current) {
            waypointPopupRef.current.remove();
          }
          waypointPopupRef.current = new maplibregl.Popup({
            closeButton: true,
            closeOnClick: true,
            className: 'waypoint-action-popup'
          })
            .setLngLat([stop.coord.lng, stop.coord.lat])
            .setHTML(popupContent)
            .addTo(mapRef.current);
        });
      }

      waypointMarkersRef.current.push(marker);
    });
  }, [stops, route, selectedMode, optimizeOrder]);

  const updateRiderLocation = useCallback((newPos: LatLng, rawHeading: number | null, newSpeed: number) => {
    let finalPos = newPos;
    let finalHeading = rawHeading;
    let currentSegmentIndex = -1;

    // SNAP-TO-ROUTE LOGIC
    if (appStatusRef.current === AppStatus.NAVIGATING && routeRef.current) {
      const { point, bearing, segmentIndex } = getNearestPointOnLine(newPos, routeRef.current.polyline);
      finalPos = point;
      // Only use segment bearing if we don't have a good raw heading or GPS is drifting
      if (rawHeading === null || newSpeed < 5) { // < 5km/h rely on route
        finalHeading = bearing;
      }
      currentSegmentIndex = segmentIndex;
      updateRouteVisuals(finalPos, routeRef.current.polyline, segmentIndex);
    } else if (finalHeading === null && lastPosRef.current) {
      const dist = getDistance(lastPosRef.current, newPos);
      if (dist > 0.000001) {
        finalHeading = calculateBearing(lastPosRef.current, newPos);
      }
    }

    if (appStatusRef.current === AppStatus.NAVIGATING && routeRef.current && currentSegmentIndex >= 0) {
      // If we heavily trust the route (simulation), override with lookahead
      if (isSimulating) {
        const lookAheadMeters = Math.min(60, Math.max(LOOKAHEAD_BASE_METERS, newSpeed * 0.6));
        const routeBearing = getLookaheadBearing(routeRef.current, currentSegmentIndex, finalPos, lookAheadMeters);
        if (routeBearing !== null) {
          finalHeading = routeBearing;
        }
      }
    }

    // Performance: Throttle state updates to max 10Hz (every 100ms)
    pendingPosRef.current = finalPos;
    pendingSpeedRef.current = newSpeed;

    // HEADING FILTER: Don't update heading if speed is very low to prevent jitter at red lights
    // Unless in simulation where speed might be simulated 0 but we want to turn
    if (newSpeed >= 3 || isSimulating || pendingHeadingRef.current === null) {
      if (finalHeading !== null) {
        pendingHeadingRef.current = finalHeading;
      }
    }

    lastPosRef.current = finalPos;

    const now = Date.now();
    if (now - lastStateUpdateTimeRef.current >= 100) {
      lastStateUpdateTimeRef.current = now;
      setCurrentPos(pendingPosRef.current);
      setSpeed(pendingSpeedRef.current || 0);

      if (pendingHeadingRef.current !== null) {
        setHeading(prev => {
          const finalH = pendingHeadingRef.current!;
          let diff = finalH - prev;
          if (diff > 180) diff -= 360;
          if (diff < -180) diff += 360;
          return (prev + diff * 0.15 + 360) % 360;
        });
      }
    }

    // Always update the smoothed ref for animation immediately, don't throttle
    const movementHeading = pendingHeadingRef.current !== null ? pendingHeadingRef.current : (heading || 0);
    smoothedHeadingRef.current = smoothAngle(smoothedHeadingRef.current, movementHeading, 0.12);

    if (mapRef.current && mapLoaded) {
      if (!markerRef.current) {
        const markerEl = document.createElement('div');
        markerEl.className = 'rider-marker-icon';
        markerEl.innerHTML = `<div class="rider-arrow-container"><div class="rider-pulse"></div><div id="rider-arrow" class="rider-arrow"></div></div>`;
        markerRef.current = new maplibregl.Marker({
          element: markerEl,
          anchor: 'center',
          rotationAlignment: 'viewport',
          pitchAlignment: 'viewport'
        })
          .setLngLat([finalPos.lng, finalPos.lat])
          .addTo(mapRef.current);
      } else {
        markerRef.current.setLngLat([finalPos.lng, finalPos.lat]);
      }

      const el = markerRef.current.getElement();
      const arrowEl = el.querySelector('#rider-arrow') as HTMLElement | null;

      const currentMapBearing = mapBearingRef.current;
      const trueHeading = smoothedHeadingRef.current;

      // ARROW ROTATION LOGIC
      // The arrow should point in the direction of travel relative to the screen "up".
      // Screen Up = 0 deg relative to viewport.
      // Map Bearing = Rotation of map relative to North.
      // If Map Bearing is 0 (North Up), Arrow Rotation = True Heading.
      // If Map Bearing is 90 (West Up), and True Heading is 90 (East), Arrow should point Right (90). 
      // Wait, Map Bearing 90 means North is Rotated 90 deg clockwise? 
      // Usually bearing in mapbox: "The desired bearing, in degrees. The bearing is the compass direction that is "up"; for example, 90° orients the map so that east is up."
      // If East is Up (90), and we are driving East (90), Arrow should point UP (0).
      // So Arrow Rotation = True Heading - Map Bearing.
      // 90 - 90 = 0. Correct.
      // If North is Up (0), we driving East (90), Arrow = 90 - 0 = 90 (Right). Correct.

      let arrowRotation = (trueHeading - currentMapBearing);
      if (arrowRotation < 0) arrowRotation += 360;
      arrowRotation = arrowRotation % 360;

      if (arrowEl) {
        arrowEl.style.transform = `rotate(${arrowRotation}deg)`;
      }

      if (isFollowingRef.current) {
        const shouldUpdateView = now - lastMapViewUpdateTimeRef.current >= 40; // 25fps map updates
        if (shouldUpdateView) {
          lastMapViewUpdateTimeRef.current = now;
          let viewCenter = [finalPos.lng, finalPos.lat];
          let targetPitch = 0;
          let targetBearing = mapBearingRef.current;

          if (appStatusRef.current === AppStatus.NAVIGATING) {
            const zoom = zoomLevelRef.current;
            const metersPerPixel = (156543.03392 * Math.cos(finalPos.lat * Math.PI / 180)) / Math.pow(2, zoom);

            // In portrait mode, offset the map center so rider appears at 75% down the screen
            const pixelOffset = (window.innerHeight > window.innerWidth)
              ? (window.innerHeight * 0.25) / 1.7
              : 0;

            const distanceMeters = pixelOffset * metersPerPixel;
            const earthRadius = 6378137;

            // Move map center along the CURRENT MAP BEARING (which is "Up") 
            // actually we want the rider to be "down" which implies moving center "up" relative to screen
            // "Up" relative to screen is Map Bearing direction.
            // So we move center in direction of Map Bearing.
            const offsetBearing = currentMapBearing;

            const dLat = (distanceMeters * Math.cos(offsetBearing * Math.PI / 180)) / earthRadius;
            const dLng = (distanceMeters * Math.sin(offsetBearing * Math.PI / 180)) / (earthRadius * Math.cos(finalPos.lat * Math.PI / 180));

            if (!isNaN(dLat) && !isNaN(dLng)) {
              viewCenter = [finalPos.lng + dLng * (180 / Math.PI), finalPos.lat + dLat * (180 / Math.PI)];
            }
            targetPitch = 50;

            // Map should rotate to follow True Heading
            targetBearing = (trueHeading) % 360;
          }

          mapBearingRef.current = smoothAngle(mapBearingRef.current, targetBearing, 0.1);

          mapRef.current.jumpTo({
            center: viewCenter,
            zoom: zoomLevelRef.current,
            pitch: targetPitch,
            bearing: mapBearingRef.current
          });
        }
      }
    }

    if (
      appStatusRef.current === AppStatus.NAVIGATING &&
      routeRef.current &&
      currentSegmentIndex >= 0
    ) {
      const distances = polylineDistancesRef.current;
      const maneuverMeta = maneuverMetaRef.current;
      if (distances && distances.length > currentSegmentIndex && maneuverMeta.length > 0) {
        const routePolyline = routeRef.current.polyline;
        const segStart = routePolyline[currentSegmentIndex];
        const progressDist = distances[currentSegmentIndex] + getDistanceMeters(segStart, finalPos);
        const distanceToLine = getDistanceMeters(newPos, finalPos);
        const offRouteThreshold = getOffRouteThreshold(newSpeed);

        if (distanceToLine > offRouteThreshold) {
          offRouteCounterRef.current += 1;
        } else {
          offRouteCounterRef.current = 0;
        }

        if (offRouteCounterRef.current >= 3 && !reroutingRef.current) {
          const nowMs = Date.now();
          if (nowMs - lastRerouteTimeRef.current > 15000) {
            lastRerouteTimeRef.current = nowMs;
            if (debugNavRef.current) {
              console.log('[nav] off-route reroute', {
                distanceToLine: Math.round(distanceToLine),
                threshold: offRouteThreshold
              });
            }
            reroutingRef.current = true;
            const validStops = stops.filter(s => s.coord);
            let routePoints: LatLng[] = [];
            if (validStops.length >= 1) {
              if (stops[0].coord) {
                const remainingStops = validStops.slice(1).map(s => s.coord!);
                routePoints = [newPos, ...remainingStops];
              } else {
                routePoints = [newPos, ...validStops.map(s => s.coord!)];
              }
            }

            if (routePoints.length >= 2) {
              calculateRoute(routePoints, selectedMode, { highways: selectedMode === RoutingMode.FAST, sand: true, tolls: false }, optimizeOrder)
                .then(res => {
                  setRoute(res);
                  setAppStatus(AppStatus.NAVIGATING);
                  currentSegmentIndexRef.current = -1;
                  lastRouteVisualPosRef.current = null;
                  updateRouteVisuals(res.polyline[0], res.polyline, 0);
                })
                .catch(e => {
                  setErrorMessage(e.message || "Route recalculation failed.");
                  setAppStatus(AppStatus.NAVIGATING);
                })
                .finally(() => {
                  reroutingRef.current = false;
                  offRouteCounterRef.current = 0;
                });
            } else {
              reroutingRef.current = false;
              offRouteCounterRef.current = 0;
            }
          }
        }

        let activeIndex = Math.min(
          Math.max(currentManeuverIndexRef.current, 0),
          maneuverMeta.length - 1
        );
        const initialIndex = activeIndex;

        const skipPastThreshold = getAdvanceThreshold(newSpeed) + 15;
        while (activeIndex < maneuverMeta.length - 1 && progressDist - maneuverMeta[activeIndex].distanceAlong > skipPastThreshold) {
          activeIndex += 1;
        }

        const backtrackThreshold = getAdvanceThreshold(newSpeed) + 30;
        while (activeIndex > 0 && maneuverMeta[activeIndex].distanceAlong - progressDist > backtrackThreshold) {
          activeIndex -= 1;
        }

        const distanceToManeuver = maneuverMeta[activeIndex].distanceAlong - progressDist;
        const headingToUse = finalHeading ?? smoothedHeadingRef.current;
        const bearingDelta = headingToUse !== null
          ? getBearingDelta(headingToUse, maneuverMeta[activeIndex].postBearing)
          : null;
        const bearingMatch = bearingDelta !== null && bearingDelta <= getBearingThreshold(newSpeed);
        const advanceThreshold = getAdvanceThreshold(newSpeed);
        const passedThreshold = 10;

        if (debugNavRef.current && activeIndex !== initialIndex) {
          console.log('[nav] step-shift', {
            from: initialIndex,
            to: activeIndex,
            reason: activeIndex > initialIndex ? 'progress' : 'backtrack',
            distanceToManeuver: Math.round(distanceToManeuver),
            snapped: { lat: Number(finalPos.lat.toFixed(6)), lng: Number(finalPos.lng.toFixed(6)) }
          });
        }

        let advanceReason: string | null = null;
        if (distanceToManeuver <= -passedThreshold) {
          advanceReason = 'passed';
        } else if (distanceToManeuver <= advanceThreshold && bearingMatch) {
          advanceReason = 'bearing-match';
        }

        if (advanceReason && activeIndex < maneuverMeta.length - 1) {
          activeIndex += 1;
          if (debugNavRef.current) {
            console.log('[nav] advance', {
              reason: advanceReason,
              activeIndex,
              distanceToManeuver: Math.round(distanceToManeuver),
              bearingDelta: bearingDelta !== null ? Math.round(bearingDelta) : null
            });
          }
        }

        const remainingMeters = Math.max(0, maneuverMeta[activeIndex].distanceAlong - progressDist);
        const prevRemaining = currentManeuverRemainingRef.current;
        const indexChanged = activeIndex !== currentManeuverIndexRef.current;
        if (prevRemaining === null || Math.abs(prevRemaining - remainingMeters) >= 10 || indexChanged) {
          currentManeuverRemainingRef.current = remainingMeters;
          setCurrentManeuverRemaining(remainingMeters);
        }
        if (indexChanged) {
          currentManeuverIndexRef.current = activeIndex;
          setCurrentManeuverIndex(activeIndex);
          if (debugNavRef.current) {
            console.log('[nav] step', {
              activeIndex,
              distanceToManeuver: Math.round(distanceToManeuver),
              remainingMeters: Math.round(remainingMeters),
              roadName: maneuverMeta[activeIndex]?.roadName || null,
              maneuverLocation: maneuverMeta[activeIndex]?.location || null,
              snapped: { lat: Number(finalPos.lat.toFixed(6)), lng: Number(finalPos.lng.toFixed(6)) }
            });
          }
        }
      }
    }
  }, [mapLoaded, heading, updateRouteVisuals, isSimulating, stops, selectedMode, optimizeOrder]);

  useEffect(() => {
    if (mapLoaded) {
      updateWaypointMarkers();
    }
  }, [mapLoaded, stops, updateWaypointMarkers]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    if (appStatus !== AppStatus.NAVIGATING) {
      mapBearingRef.current = 0;
      mapRef.current.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }
  }, [appStatus, mapLoaded]);

  useEffect(() => {
    if (appStatus !== AppStatus.NAVIGATING) {
      currentManeuverRemainingRef.current = null;
      setCurrentManeuverRemaining(null);
    }
  }, [appStatus, route]);

  // Create global function for popup button to call
  useEffect(() => {
    (window as any).removeWaypoint = (index: number) => {
      const newStops = stops.filter((_, i) => i !== index);
      setStops(newStops);

      if (waypointPopupRef.current) {
        waypointPopupRef.current.remove();
        waypointPopupRef.current = null;
      }

      // Recalculate route if it exists
      if (route) {
        const validStops = newStops.filter(s => s.coord);
        if (validStops.length >= 1) {
          let routePoints: LatLng[] = [];
          if (newStops[0].coord) {
            routePoints = validStops.map(s => s.coord!);
          } else {
            const start = currentPos || { lat: 52.3676, lng: 4.9041 };
            routePoints = [start, ...validStops.map(s => s.coord!)];
          }

          setAppStatus(AppStatus.PREVIEW);
          calculateRoute(routePoints, selectedMode, { highways: selectedMode === RoutingMode.FAST, sand: true, tolls: false }, optimizeOrder)
            .then(res => {
              setRoute(res);
              setAppStatus(AppStatus.CONFIRM);

              if (mapRef.current) {
                const map = mapRef.current;
                const aheadSourceId = 'route-ahead';
                const behindSourceId = 'route-behind';

                if (!map.getSource(aheadSourceId)) {
                  updateRouteVisuals(res.polyline[0], res.polyline, 0);
                } else {
                  const aheadSource = map.getSource(aheadSourceId) as maplibregl.GeoJSONSource | undefined;
                  const behindSource = map.getSource(behindSourceId) as maplibregl.GeoJSONSource | undefined;
                  aheadSource?.setData(buildLineFeature(res.polyline));
                  behindSource?.setData(buildLineFeature([]));
                }

                const lngs = res.polyline.map(p => p.lng);
                const lats = res.polyline.map(p => p.lat);
                const bounds: [[number, number], [number, number]] = [
                  [Math.min(...lngs), Math.min(...lats)],
                  [Math.max(...lngs), Math.max(...lats)]
                ];
                map.fitBounds(bounds, { padding: 50 });
                setIsFollowing(false);
              }
            })
            .catch(e => {
              setErrorMessage(e.message || "Route calculation failed.");
              setAppStatus(AppStatus.IDLE);
            });
        } else {
          setRoute(null);
          setAppStatus(AppStatus.IDLE);
        }
      }
    };

    return () => {
      delete (window as any).removeWaypoint;
    };
  }, [stops, route, selectedMode, optimizeOrder, currentPos]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current || !baseMapPmtilesUrl) return;
    if (!pmtilesProtocolRef.current) {
      pmtilesProtocolRef.current = new Protocol();
      maplibregl.addProtocol('pmtiles', pmtilesProtocolRef.current.tile);
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: buildBaseMapStyle(baseMapPmtilesUrl),
      center: [5.2913, 52.1326],
      zoom: 7,
      attributionControl: false,
      maxPitch: 70
    });

    mapRef.current = map;
    map.on('load', () => setMapLoaded(true));
    map.on('dragstart', () => setIsFollowing(false));
    map.on('zoomend', () => setZoomLevel(map.getZoom()));

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [baseMapPmtilesUrl]);

  const mapTransformStyles = useMemo(() => ({}), []);

  // Auto-request GPS permission on load to trigger iOS prompt immediately
  useEffect(() => {
    if (!("geolocation" in navigator) || gpsActive) return;

    const timer = setTimeout(() => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGpsActive(true);
          setGpsPermissionDenied(false);
        },
        (err) => {
          // Only show banner if explicitly denied, not on timeout or unavailable
          if (err.code === 1) { // PERMISSION_DENIED = 1
            setGpsPermissionDenied(true);
          }
        },
        { enableHighAccuracy: false, timeout: 3000, maximumAge: Infinity }
      );
    }, 1000);

    return () => clearTimeout(timer);
  }, [gpsActive]);

  useEffect(() => {
    if (!("geolocation" in navigator) || isSimulating) return;
    const watchId = navigator.geolocation.watchPosition((pos) => {
      setGpsActive(true);
      setGpsPermissionDenied(false);
      const newPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateRiderLocation(newPos, pos.coords.heading, pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0);
    }, (err) => {
      // Don't immediately deactivate GPS on every error
      if (err.code === 1) { // PERMISSION_DENIED = 1
        setGpsActive(false);
        setGpsPermissionDenied(true);
      }
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 });  // Performance: Allow 1s GPS cache
    return () => navigator.geolocation.clearWatch(watchId);
  }, [mapLoaded, isSimulating, updateRiderLocation]);

  const requestGPSPermission = async () => {
    if (!("geolocation" in navigator)) {
      alert('Geolocation is not supported by your browser');
      return;
    }

    try {
      // For iOS, we need to request permission explicitly
      const result = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        });
      });

      setGpsActive(true);
      setGpsPermissionDenied(false);
      const newPos = { lat: result.coords.latitude, lng: result.coords.longitude };
      updateRiderLocation(newPos, result.coords.heading, result.coords.speed ? Math.round(result.coords.speed * 3.6) : 0);

      if (mapRef.current) {
        mapRef.current.flyTo({ center: [newPos.lng, newPos.lat], zoom: 15 });
      }
    } catch (err: any) {
      console.error('GPS permission error:', err);
      if (err.code === 1) { // PERMISSION_DENIED
        setGpsPermissionDenied(true);
        alert('Please enable location access:\\n\\n1. Open iPhone Settings\\n2. Scroll to Safari\\n3. Tap Location\\n4. Select "Allow"\\n\\nThen refresh this page.');
      } else if (err.code === 2) { // POSITION_UNAVAILABLE
        alert('Location unavailable. Please check your device settings.');
      } else if (err.code === 3) { // TIMEOUT
        alert('Location request timed out. Please try again.');
      }
    }
  };

  const startSimulation = () => {
    if (!route || route.polyline.length < 2) return;
    if (mapRef.current) {
      const map = mapRef.current;
      const aheadSource = map.getSource('route-ahead') as maplibregl.GeoJSONSource | undefined;
      const behindSource = map.getSource('route-behind') as maplibregl.GeoJSONSource | undefined;
      aheadSource?.setData(buildLineFeature([]));
      behindSource?.setData(buildLineFeature([]));
    }

    setIsSimulating(true);
    setIsFollowing(true);
    setAppStatus(AppStatus.NAVIGATING);
    setZoomLevel(17.5);
    distanceRef.current = 0;
    setCurrentManeuverIndex(0);
    currentManeuverRemainingRef.current = maneuverMetaRef.current[0]?.distanceAlong ?? route.maneuvers[0]?.distance ?? null;
    setCurrentManeuverRemaining(currentManeuverRemainingRef.current);
    simLastTimeRef.current = null;
    simLastDistRef.current = 0;

    if (simIntervalRef.current) cancelAnimationFrame(simIntervalRef.current);

    const poly = route.polyline;
    const totalDist = poly.reduce((acc, p, i) => i === 0 ? 0 : acc + getDistanceMeters(poly[i - 1], p), 0);
    const SPEED_FACTOR = 0.8;
    let frameCount = 0;

    const animate = () => {
      frameCount++;
      // Performance: Run at 30 FPS instead of 60 FPS
      if (frameCount % 2 !== 0) {
        simIntervalRef.current = requestAnimationFrame(animate);
        return;
      }
      const now = performance.now();
      distanceRef.current += SPEED_FACTOR;
      if (distanceRef.current >= totalDist) {
        stopSimulation();
        setAppStatus(AppStatus.ARRIVED);
        return;
      }

      let accumulated = 0, segIdx = 0;
      for (let i = 0; i < poly.length - 1; i++) {
        const d = getDistanceMeters(poly[i], poly[i + 1]);
        if (accumulated + d >= distanceRef.current) { segIdx = i; break; }
        accumulated += d;
      }

      const prog = (distanceRef.current - accumulated) / getDistanceMeters(poly[segIdx], poly[segIdx + 1]);
      const currentLoc = interpolate(poly[segIdx], poly[segIdx + 1], prog);
      // Lookahead a bit for better bearing
      const lookAheadProg = Math.min(1.0, prog + 0.05); // +5% along segment or snap to next 
      const lookAheadLoc = interpolate(poly[segIdx], poly[segIdx + 1], lookAheadProg);
      const bearing = calculateBearing(currentLoc, lookAheadLoc);

      let speedValue = speed;
      if (simLastTimeRef.current !== null) {
        const deltaTimeSec = (now - simLastTimeRef.current) / 1000;
        if (deltaTimeSec > 0) {
          const deltaDist = distanceRef.current - simLastDistRef.current;
          const deltaMeters = (deltaDist / totalDist) * route.distance;
          const kmh = (deltaMeters / deltaTimeSec) * 3.6;
          speedValue = Math.max(0, Math.round(kmh));
        }
      }
      simLastTimeRef.current = now;
      simLastDistRef.current = distanceRef.current;

      updateRiderLocation(currentLoc, bearing, speedValue);

      simIntervalRef.current = requestAnimationFrame(animate);
    };

    simIntervalRef.current = requestAnimationFrame(animate);
  };

  const stopSimulation = () => {
    setIsSimulating(false);
    if (simIntervalRef.current) cancelAnimationFrame(simIntervalRef.current);
    if (mapRef.current) {
      const map = mapRef.current;
      const aheadSource = map.getSource('route-ahead') as maplibregl.GeoJSONSource | undefined;
      const behindSource = map.getSource('route-behind') as maplibregl.GeoJSONSource | undefined;
      aheadSource?.setData(buildLineFeature([]));
      behindSource?.setData(buildLineFeature([]));
    }
  };

  const handlePlanRide = async (modeOverride?: RoutingMode) => {
    setErrorMessage(null);
    const mode = modeOverride || selectedMode;
    const validStops = stops.filter(s => s.coord);
    if (validStops.length === 0) {
      setErrorMessage("Please select a destination.");
      return;
    }

    let routePoints: LatLng[] = [];
    if (stops[0].coord) {
      routePoints = validStops.map(s => s.coord!);
    } else {
      const start = currentPos || { lat: 52.3676, lng: 4.9041 };
      routePoints = [start, ...validStops.map(s => s.coord!)];
    }

    setAppStatus(AppStatus.PREVIEW);
    try {
      const res = await calculateRoute(routePoints, mode, { highways: mode === RoutingMode.FAST, sand: true, tolls: false }, optimizeOrder);
      setRoute(res);
      setAppStatus(AppStatus.CONFIRM);

      if (mapRef.current) {
        // Reset rendering throttling state so the new route is definitely drawn
        currentSegmentIndexRef.current = -1;
        lastRouteVisualPosRef.current = null;

        // Use the centralized visual updater which handles source creation if needed
        updateRouteVisuals(res.polyline[0], res.polyline, 0);

        const lngs = res.polyline.map(p => p.lng);
        const lats = res.polyline.map(p => p.lat);
        const bounds: [[number, number], [number, number]] = [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)]
        ];
        mapRef.current.fitBounds(bounds, { padding: 100 });
        setIsFollowing(false);
      }
    } catch (e: any) {
      setErrorMessage(e.message || "Route calculation failed.");
      setAppStatus(AppStatus.IDLE);
    }
  };

  const onInputChange = (index: number, val: string) => {
    const newStops = [...stops];
    newStops[index].address = val;

    // Clear coord when input is emptied
    if (val.length === 0) {
      newStops[index].coord = null;
    }

    setStops(newStops);
    setActiveSearchIndex(index);

    // Clear suggestions if input is empty
    if (val.length === 0) {
      setSuggestions([]);
      return;
    }

    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(async () => {
      if (val.length < 2) return;
      try {
        const center = currentPos || { lat: 51.6978, lng: 5.3037 };
        const results = await searchNominatim(
          val,
          center,
          userCountry || undefined,
          true,  // bounded by default
          0.5,   // ~55 km radius
          6      // limit
        );
        setSuggestions(results);
      } catch (e) {
        console.warn('Search error', e);
        setSuggestions([]);
      }
    }, 400);
  };

  const selectMyLocation = (index: number) => {
    if (!currentPos) return;
    const newStops = [...stops];
    newStops[index] = { ...newStops[index], coord: currentPos, address: 'My Location' };
    setStops(newStops);
    setSuggestions([]);
    setActiveSearchIndex(null);
    if (mapRef.current) {
      mapRef.current.flyTo({ center: [currentPos.lng, currentPos.lat], zoom: 15 });
      setIsFollowing(false);
    }
  };

  const selectSuggestion = (index: number, sug: Suggestion) => {
    const coord = { lat: parseFloat(sug.lat), lng: parseFloat(sug.lon) };
    // Use city/town/village if available, else first part of display_name
    const shortName = sug.address?.city || sug.address?.town || sug.address?.village || sug.display_name.split(',')[0];
    const newStops = [...stops];
    newStops[index] = { ...newStops[index], coord, address: shortName };
    setStops(newStops);
    setSuggestions([]);
    setActiveSearchIndex(null);
    if (mapRef.current) {
      mapRef.current.flyTo({ center: [coord.lng, coord.lat], zoom: 15 });
      setIsFollowing(false);
    }
  };

  const addWaypoint = () => {
    const newId = `waypoint-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newStops = [...stops];
    // Insert new waypoint before the last element (destination)
    newStops.splice(stops.length - 1, 0, { address: '', coord: null, id: newId });
    setStops(newStops);
  };

  const removeWaypoint = (index: number) => {
    // Prevent removing first (A) or last (B) stop
    if (index === 0 || index === stops.length - 1 || stops.length <= 2) return;
    const newStops = stops.filter((_, i) => i !== index);
    setStops(newStops);
  };

  const moveWaypoint = (fromIndex: number, toIndex: number) => {
    // Prevent moving first (A) or last (B) stop
    if (fromIndex === 0 || fromIndex === stops.length - 1) return;
    if (toIndex === 0 || toIndex === stops.length - 1) return;
    if (toIndex < 0 || toIndex >= stops.length) return;

    const newStops = [...stops];
    const [movedStop] = newStops.splice(fromIndex, 1);
    newStops.splice(toIndex, 0, movedStop);
    setStops(newStops);
  };

  const handleGPXUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gpx,application/gpx+xml';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      // Check file size (5MB limit)
      const MAX_FILE_SIZE = 5 * 1024 * 1024;
      if (file.size > MAX_FILE_SIZE) {
        setErrorMessage('GPX file too large (max 5MB)');
        return;
      }

      setGpxLoading(true);
      setErrorMessage(null);

      try {
        const text = await file.text();
        const newStops = parseGPX(text);

        if (newStops.length < 2) {
          throw new Error('GPX file must contain at least 2 waypoints');
        }

        setStops(newStops);

        // Auto-fit map to show all waypoints
        if (mapRef.current && newStops.length > 0) {
          const coords = newStops
            .filter(s => s.coord)
            .map(s => [s.coord!.lng, s.coord!.lat] as [number, number]);

          if (coords.length > 0) {
            const lngs = coords.map(c => c[0]);
            const lats = coords.map(c => c[1]);
            const bounds: [[number, number], [number, number]] = [
              [Math.min(...lngs), Math.min(...lats)],
              [Math.max(...lngs), Math.max(...lats)]
            ];
            mapRef.current.fitBounds(bounds, { padding: 50 });
            setIsFollowing(false);
          }
        }

        // Clear any existing route
        setRoute(null);
        setAppStatus(AppStatus.IDLE);

      } catch (error: any) {
        console.error('GPX parsing error:', error);
        setErrorMessage(error.message || 'Failed to parse GPX file');
      } finally {
        setGpxLoading(false);
      }
    };
    input.click();
  };

  const arrivalTime = useMemo(() => {
    if (!route) return '--:--';
    const d = new Date(); d.setSeconds(d.getSeconds() + route.duration);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [route]);

  const hasDestination = useMemo(() => stops[1].coord !== null || stops.slice(2).some(s => s.coord !== null), [stops]);

  return (
    <div className="flex h-screen w-full relative bg-slate-950 font-sans overflow-hidden">
      <div className="map-wrapper" style={mapTransformStyles}>
        <div ref={mapContainerRef} className="h-full w-full bg-slate-950" />
      </div>

      {/* GPS Permission Prompt */}
      {gpsPermissionDenied && !gpsActive && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] pointer-events-auto">
          <div className="glass-panel px-4 py-3 rounded-2xl shadow-2xl border border-orange-100 max-w-sm">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="font-bold text-slate-100 text-sm mb-1">GPS Permission Required</h3>
                <p className="text-xs text-slate-300 mb-3">Enable location access to use navigation features</p>
                <button
                  onClick={requestGPSPermission}
                  className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-2 px-4 rounded-lg text-sm transition-all active:scale-95"
                >
                  Enable Location
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Zoom and UI toggle buttons - always visible */}
      <div className="absolute right-3 top-1/2 -translate-y-1/2 z-[300] flex flex-col gap-1.5">
        <button
          onClick={() => mapRef.current?.zoomIn()}
          className={`w-9 h-9 glass-panel rounded-xl flex items-center justify-center text-slate-200 hover:text-blue-400 font-bold text-lg shadow-lg transition-all active:scale-90 ${!isUIVisible ? 'opacity-0 pointer-events-none' : ''}`}
        >+</button>
        <button
          onClick={() => setIsUIVisible(!isUIVisible)}
          className="w-9 h-9 glass-panel rounded-xl flex items-center justify-center text-slate-200 hover:text-blue-400 shadow-lg transition-all active:scale-90"
          aria-label={isUIVisible ? "Hide UI" : "Show UI"}
        >
          {isUIVisible ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
        </button>
        <button
          onClick={() => mapRef.current?.zoomOut()}
          className={`w-9 h-9 glass-panel rounded-xl flex items-center justify-center text-slate-200 hover:text-blue-400 font-bold text-lg shadow-lg transition-all active:scale-90 ${!isUIVisible ? 'opacity-0 pointer-events-none' : ''}`}
        >−</button>
      </div>

      <div className={`absolute inset-0 pointer-events-none transition-opacity duration-300 ${isUIVisible ? 'opacity-100' : 'opacity-0'}`}>
        <div className={`${isUIVisible ? 'pointer-events-auto' : 'pointer-events-none'}`}>

          <div className="absolute top-3 right-3 z-[100] flex flex-col items-end gap-1.5 pointer-events-none">
            <div className="glass-panel px-2 py-1 rounded-full flex items-center gap-1.5 pointer-events-auto shadow-md">
              <div className={(gpsActive || isSimulating) ? "signal-dot" : "w-1.5 h-1.5 bg-slate-300 rounded-full"} />
              <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">
                {isSimulating ? "Simulation Mode" : (gpsActive ? "GPS Active" : "Searching Satellites...")}
              </span>
            </div>
            {errorMessage && (
              <div className="glass-panel px-3 py-1.5 rounded-xl bg-red-50 border-red-200 text-red-600 text-[10px] font-bold pointer-events-auto shadow-lg">
                {errorMessage}
              </div>
            )}
          </div>

          <div className="absolute top-3 w-full px-3 md:px-0 md:max-w-lg left-1/2 -translate-x-1/2 z-[200]">
            {appStatus === AppStatus.NAVIGATING && route ? (
              <div className="glass-panel rounded-2xl p-3 flex items-center gap-3 animate-in slide-in-from-top duration-700 shadow-xl">
                <div className="w-9 h-9 bg-blue-500 rounded-xl flex items-center justify-center text-white shrink-0 shadow-md text-sm">
                  {MANEUVER_ICONS[route.maneuvers[currentManeuverIndex]?.type as keyof typeof MANEUVER_ICONS] || MANEUVER_ICONS['straight']}
                </div>
                <div className="overflow-hidden">
                  <h2 className="text-sm font-bold text-slate-100 tracking-tight truncate">{route.maneuvers[currentManeuverIndex]?.instruction || "Continue ahead"}</h2>
                  <p className="text-blue-500 font-medium text-[10px] uppercase tracking-wider">
                    {currentManeuverIndex < route.maneuvers.length - 1
                      ? `In ${Math.round((currentManeuverRemaining ?? route.maneuvers[currentManeuverIndex]?.distance) || 0)}m`
                      : 'Ride Smoothly to Destination'}
                  </p>
                </div>
              </div>
            ) : (
              appStatus !== AppStatus.NAVIGATING && (
                <div className="flex flex-col gap-2">
                  <div className="glass-panel p-3 rounded-2xl flex flex-col gap-2 shadow-xl relative">
                    <h3 className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] mb-0.5">Planned Route</h3>
                    {stops.map((stop, index) => (
                      <div key={stop.id} className="relative">
                        <div className="flex items-center gap-2">
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${stop.coord ? 'bg-blue-500 text-white' : 'bg-slate-700 text-slate-500'}`}>
                            {index === 0 ? "A" : index === stops.length - 1 ? "B" : index}
                          </div>
                          <input
                            className="flex-grow bg-slate-800/50 rounded-lg px-3 py-2 border border-slate-700 text-base outline-none text-slate-100 font-bold focus:bg-slate-800 focus:border-blue-500 transition-all placeholder:text-slate-500"
                            placeholder={index === 0 ? "Optional Start Location" : index === stops.length - 1 ? "Enter Destination..." : `Waypoint ${index}`}
                            value={stop.address}
                            onChange={e => onInputChange(index, e.target.value)}
                            onFocus={(e) => {
                              setActiveSearchIndex(index);
                              if (stop.address === 'My Location') {
                                e.target.select();
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && suggestions.length > 0 && activeSearchIndex === index) {
                                e.preventDefault();
                                selectSuggestion(index, suggestions[0]);
                              }
                            }}
                            onBlur={() => setTimeout(() => setActiveSearchIndex(null), 300)}
                          />
                          {stops.length > 2 && index !== 0 && index !== stops.length - 1 && (
                            <div className="flex gap-1">
                              <button
                                onClick={() => moveWaypoint(index, index - 1)}
                                disabled={index === 1}
                                className="w-5 h-5 rounded-full bg-slate-50 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-slate-600 transition-all active:scale-95 shrink-0"
                                title="Move up"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
                                </svg>
                              </button>
                              <button
                                onClick={() => moveWaypoint(index, index + 1)}
                                disabled={index === stops.length - 2}
                                className="w-5 h-5 rounded-full bg-slate-50 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-slate-600 transition-all active:scale-95 shrink-0"
                                title="Move down"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                                </svg>
                              </button>
                              <button
                                onClick={() => removeWaypoint(index)}
                                className="w-5 h-5 rounded-full bg-red-50 hover:bg-red-100 flex items-center justify-center text-red-500 transition-all active:scale-95 shrink-0"
                                title="Remove waypoint"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          )}
                        </div>
                        {activeSearchIndex === index && (
                          <>
                            {/* Show "My Location" when input is empty and GPS is available */}
                            {stops[index].address === '' && currentPos && (
                              <div className="absolute left-7 right-0 top-full mt-1.5 glass-panel rounded-xl overflow-hidden shadow-xl z-[999] border-blue-50 border">
                                <button
                                  onMouseDown={(e) => { e.preventDefault(); selectMyLocation(index); }}
                                  onTouchStart={(e) => { e.preventDefault(); selectMyLocation(index); }}
                                  className="w-full text-left px-3 py-2.5 hover:bg-blue-50 active:bg-blue-100 transition-colors group"
                                >
                                  <div className="flex items-center gap-2">
                                    <svg className="w-4 h-4 text-blue-500" fill="currentColor" viewBox="0 0 24 24">
                                      <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0013 3.06V1h-2v2.06A8.994 8.994 0 003.06 11H1v2h2.06A8.994 8.994 0 0011 20.94V23h2v-2.06A8.994 8.994 0 0020.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" />
                                    </svg>
                                    <div className="font-bold text-slate-100 text-xs group-hover:text-blue-400">
                                      My Location
                                    </div>
                                  </div>
                                  <div className="text-[10px] text-slate-500 mt-0.5 ml-6">
                                    Use current GPS position
                                  </div>
                                </button>
                              </div>
                            )}
                            {/* Show search suggestions when typing */}
                            {suggestions.length > 0 && (
                              <div className="absolute left-7 right-0 top-full mt-1.5 glass-panel rounded-xl overflow-hidden shadow-xl z-[999] border-blue-50 border">
                                {suggestions.map((sug, i) => {
                                  const streetName = sug.display_name.split(',')[0];
                                  const city = sug.address?.city || sug.address?.town || sug.address?.village || '';
                                  const country = sug.address?.country_code?.toUpperCase() || '';

                                  return (
                                    <button
                                      key={i}
                                      onMouseDown={(e) => { e.preventDefault(); selectSuggestion(index, sug); }}
                                      onTouchStart={(e) => { e.preventDefault(); selectSuggestion(index, sug); }}
                                      className="w-full text-left px-3 py-2.5 hover:bg-blue-50 active:bg-blue-100 border-b border-slate-50 last:border-0 transition-colors group"
                                    >
                                      <div className="font-bold text-slate-100 text-xs truncate group-hover:text-blue-400">
                                        {streetName}
                                      </div>
                                      {(city || country) && (
                                        <div className="text-[10px] text-slate-500 mt-0.5 truncate">
                                          {city && <span>{city}</span>}
                                          {city && country && <span className="mx-1">•</span>}
                                          {country && <span className="font-semibold">{country}</span>}
                                        </div>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                    {/* Show Import GPX button only when nothing is filled in */}
                    {!stops.some(s => s.coord !== null) && (
                      <button
                        onClick={handleGPXUpload}
                        className="w-full py-1.5 text-[9px] font-black text-slate-500 hover:text-purple-400 uppercase tracking-widest transition-all hover:bg-purple-900/30 rounded-lg active:scale-95 flex items-center justify-center gap-1.5"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                        Import GPX Route
                      </button>
                    )}
                    {/* Show Add Stop button when at least one location is filled */}
                    {stops.some(s => s.coord !== null) && (
                      <button
                        onClick={addWaypoint}
                        className="w-full py-1.5 text-[9px] font-black text-slate-500 hover:text-blue-400 uppercase tracking-widest transition-all hover:bg-blue-900/30 rounded-lg active:scale-95 flex items-center justify-center gap-1.5"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
                        </svg>
                        Add Stop
                      </button>
                    )}
                  </div>
                  {hasDestination && (appStatus === AppStatus.IDLE || appStatus === AppStatus.CONFIRM) && (
                    <div className="glass-panel p-1.5 rounded-xl flex gap-1.5 overflow-x-auto no-scrollbar shadow-lg">
                      {(Object.entries(MODE_LABELS) as [RoutingMode, typeof MODE_LABELS['fast']][]).map(([mode, meta]) => (
                        <button key={mode} onClick={() => { setSelectedMode(mode); handlePlanRide(mode); }} className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg text-[9px] font-black uppercase transition-all min-w-[75px] active:scale-95 ${selectedMode === mode ? 'bg-blue-500 text-white shadow-md' : 'bg-slate-700/50 text-slate-400 hover:bg-slate-700'}`}>
                          <span className="text-base mb-0.5">{meta.icon}</span>
                          <span>{meta.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            )}
          </div>

          <div className="absolute bottom-4 w-full px-3 md:px-0 md:max-w-lg left-1/2 -translate-x-1/2 z-[200]">
            {!isFollowing && currentPos && (
              <div className="flex justify-center mb-3">
                <button onClick={() => { setIsFollowing(true); setZoomLevel(17.5); }} className="glass-panel px-4 py-2 rounded-full flex items-center gap-2 text-blue-400 font-black text-[9px] uppercase tracking-widest shadow-xl hover:bg-slate-800 transition-all active:scale-95">CENTER ON RIDER</button>
              </div>
            )}

            {appStatus === AppStatus.CONFIRM && route && (
              <div className="glass-panel p-4 rounded-2xl mb-3 animate-in slide-in-from-bottom duration-700 shadow-xl border-blue-50">
                <div className="flex justify-around mb-4 bg-slate-800/50 py-3 rounded-xl">
                  <div className="text-center"><p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Curves</p><p className="text-base font-bold text-blue-400">{route.stats.curvatureIndex}/10</p></div>
                  <div className="text-center border-x border-slate-700 px-6"><p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Time</p><p className="text-base font-bold text-slate-200">{Math.round(route.duration / 60)}m</p></div>
                  <div className="text-center"><p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Scenic</p><p className="text-base font-bold text-emerald-400">{route.stats.scenicIndex}/10</p></div>
                </div>
                <div className="flex flex-col gap-2">
                  <button onClick={() => { setAppStatus(AppStatus.NAVIGATING); setIsFollowing(true); setZoomLevel(17.5); }} className="w-full py-3 bg-blue-500 rounded-xl font-black text-white shadow-md uppercase tracking-widest text-[10px] active:scale-95 transition-all">Start Real Ride</button>
                  <button onClick={startSimulation} className="w-full py-3 bg-slate-700 rounded-xl font-black text-white shadow-md uppercase tracking-widest text-[10px] active:scale-95 transition-all">Realistic Simulation</button>
                  <button onClick={() => { setRoute(null); setAppStatus(AppStatus.IDLE); }} className="w-full py-1.5 text-[9px] font-black text-slate-500 uppercase tracking-widest">Adjust</button>
                </div>
              </div>
            )}

            {appStatus === AppStatus.IDLE && (
              <div className="mt-2 animate-in fade-in zoom-in duration-500 flex flex-col gap-2">
                {hasDestination ? (
                  <button onClick={() => handlePlanRide()} className="w-full py-3 bg-blue-600 text-white rounded-2xl font-black shadow-xl flex items-center justify-center gap-3 active:scale-95 transition-all">
                    <span className="uppercase tracking-widest text-xs">Preview Ride</span>
                    <span className="text-white text-base">🏍️</span>
                  </button>
                ) : (
                  <button onClick={() => { setAppStatus(AppStatus.NAVIGATING); setIsFollowing(true); setZoomLevel(17.5); }} className="w-full py-3 bg-slate-700 text-white rounded-2xl font-black shadow-xl flex items-center justify-center gap-3 active:scale-95 transition-all">
                    <span className="uppercase tracking-widest text-xs">Start Free Ride</span>
                    <svg className="w-5 h-5 text-blue-400" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z" /></svg>
                  </button>
                )}
              </div>
            )}

            {appStatus === AppStatus.NAVIGATING && (
              <div className="glass-panel p-5 rounded-3xl flex items-center justify-between mb-3 shadow-xl">
                <div className="flex gap-6">
                  <div className="text-center">
                    <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">{route ? "ETA" : "Status"}</p>
                    <p className="text-lg font-bold tabular-nums text-slate-800">{route ? arrivalTime : "LIVE"}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[8px] font-black text-blue-500 uppercase tracking-widest mb-0.5">KM/H</p>
                    <p className="text-4xl font-black tabular-nums text-slate-900 tracking-tighter">{speed}</p>
                  </div>
                </div>
                <button onClick={() => { stopSimulation(); setAppStatus(AppStatus.IDLE); }} className="w-12 h-12 bg-slate-100/50 border border-slate-200/50 rounded-2xl flex items-center justify-center text-slate-400 hover:text-red-500 active:scale-90 transition-all">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            )}
          </div>

          {appStatus === AppStatus.PREVIEW && (
            <div className="absolute inset-0 z-[1000] bg-slate-50/80 backdrop-blur-xl flex flex-col items-center justify-center">
              <div className="w-14 h-14 border-4 border-blue-500/10 border-t-blue-500 rounded-full animate-spin mb-6" />
              <p className="text-slate-600 font-black uppercase tracking-[0.3em] text-[10px] animate-pulse-soft">Calculating Optimal Path...</p>
            </div>
          )}

          {gpxLoading && (
            <div className="absolute inset-0 z-[1000] bg-slate-50/80 backdrop-blur-xl flex flex-col items-center justify-center">
              <div className="w-14 h-14 border-4 border-purple-500/10 border-t-purple-500 rounded-full animate-spin mb-6" />
              <p className="text-slate-600 font-black uppercase tracking-[0.3em] text-[10px] animate-pulse-soft">Parsing GPX File...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;
