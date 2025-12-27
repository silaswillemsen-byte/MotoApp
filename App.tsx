import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  RoutingMode,
  Avoidances,
  LatLng,
  RouteResponse,
  AppStatus
} from './types';
import { calculateRoute } from './services/routingEngine';
import { MANEUVER_ICONS } from './constants';
import { searchNominatim, reverseNominatim, NominatimResult } from './services/geocoding';
import { parseGPX } from './services/gpxParser';

declare var L: any;

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

const App: React.FC = () => {
  const [appStatus, setAppStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [selectedMode, setSelectedMode] = useState<RoutingMode>(RoutingMode.BALANCED);
  const [optimizeOrder, setOptimizeOrder] = useState(false);

  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const routeLayerAheadRef = useRef<any>(null);
  const routeLayerBehindRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const waypointMarkersRef = useRef<any[]>([]);

  // Performance: Refs for throttling state updates to prevent excessive re-renders
  const lastStateUpdateTimeRef = useRef<number>(0);
  const pendingPosRef = useRef<LatLng | null>(null);
  const pendingHeadingRef = useRef<number | null>(null);
  const pendingSpeedRef = useRef<number | null>(null);
  const currentSegmentIndexRef = useRef<number>(-1);

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

  const [isPortrait, setIsPortrait] = useState(window.innerHeight > window.innerWidth);
  useEffect(() => {
    const handleResize = () => setIsPortrait(window.innerHeight > window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

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

  const [isSimulating, setIsSimulating] = useState(false);
  const simIntervalRef = useRef<number | null>(null);
  const distanceRef = useRef(0);
  const [currentManeuverIndex, setCurrentManeuverIndex] = useState(0);

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState<number | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const getDistance = (p1: LatLng, p2: LatLng) => {
    return Math.sqrt(Math.pow(p2.lat - p1.lat, 2) + Math.pow(p2.lng - p1.lng, 2));
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

  const updateRouteVisuals = useCallback((targetPos: LatLng, polyline: LatLng[], segIdx: number) => {
    if (!mapRef.current) return;
    
    // Performance: Only update if segment actually changed
    if (currentSegmentIndexRef.current === segIdx) return;
    currentSegmentIndexRef.current = segIdx;
    
    const behindPoints = [...polyline.slice(0, segIdx + 1), targetPos];
    const aheadPoints = [targetPos, ...polyline.slice(segIdx + 1)];

    if (!routeLayerBehindRef.current) {
      routeLayerBehindRef.current = L.polyline(behindPoints.map(p => [p.lat, p.lng]), {
        color: '#3b82f6', weight: 8, opacity: 0.15, lineJoin: 'round'
      }).addTo(mapRef.current);
    } else {
      routeLayerBehindRef.current.setLatLngs(behindPoints.map(p => [p.lat, p.lng]));
    }

    if (!routeLayerAheadRef.current) {
      routeLayerAheadRef.current = L.polyline(aheadPoints.map(p => [p.lat, p.lng]), {
        color: '#3b82f6', weight: 8, opacity: 0.85, lineJoin: 'round'
      }).addTo(mapRef.current);
    } else {
      routeLayerAheadRef.current.setLatLngs(aheadPoints.map(p => [p.lat, p.lng]));
    }
  }, []);

  const updateWaypointMarkers = useCallback(() => {
    if (!mapRef.current) return;

    waypointMarkersRef.current.forEach(marker => {
      if (marker) mapRef.current.removeLayer(marker);
    });
    waypointMarkersRef.current = [];

    stops.forEach((stop, index) => {
      if (!stop.coord) return;

      const label = index === 0 ? 'A' : index === stops.length - 1 ? 'B' : index.toString();
      const isFirst = index === 0;
      const isLast = index === stops.length - 1;
      const canRemove = !isFirst && !isLast && stops.length > 2;
      
      const icon = L.divIcon({
        html: `<div style="width: 32px; height: 32px; background: ${isFirst ? '#10b981' : isLast ? '#ef4444' : '#3b82f6'}; border: 3px solid white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 900; color: white; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); ${canRemove ? 'cursor: pointer;' : ''}">${label}</div>`,
        className: '',
        iconSize: [32, 32],
        iconAnchor: [16, 16]
      });

      const marker = L.marker([stop.coord.lat, stop.coord.lng], { icon }).addTo(mapRef.current);
      
      // Make intermediate waypoints clickable to show action menu
      if (canRemove) {
        marker.on('click', (e) => {
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
          
          const popup = L.popup({
            closeButton: true,
            autoClose: true,
            closeOnClick: true,
            className: 'waypoint-action-popup'
          })
            .setLatLng([stop.coord.lat, stop.coord.lng])
            .setContent(popupContent)
            .openOn(mapRef.current);
        });
      }
      
      waypointMarkersRef.current.push(marker);
    });
  }, [stops, route, selectedMode, optimizeOrder]);

  const updateRiderLocation = useCallback((newPos: LatLng, rawHeading: number | null, newSpeed: number) => {
    let finalPos = newPos;
    let finalHeading = rawHeading;

    // SNAP-TO-ROUTE LOGIC
    if (appStatusRef.current === AppStatus.NAVIGATING && routeRef.current) {
      const { point, bearing, segmentIndex } = getNearestPointOnLine(newPos, routeRef.current.polyline);
      finalPos = point;
      finalHeading = bearing;
      updateRouteVisuals(finalPos, routeRef.current.polyline, segmentIndex);
    } else if (finalHeading === null && lastPosRef.current) {
      const dist = getDistance(lastPosRef.current, newPos);
      if (dist > 0.000001) {
        finalHeading = calculateBearing(lastPosRef.current, newPos);
      }
    }

    // Performance: Throttle state updates to max 10Hz (every 100ms)
    pendingPosRef.current = finalPos;
    pendingSpeedRef.current = newSpeed;
    if (finalHeading !== null) {
      pendingHeadingRef.current = finalHeading;
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

    if (mapRef.current && mapLoaded) {
      if (!markerRef.current) {
        markerRef.current = L.marker([finalPos.lat, finalPos.lng], {
          icon: L.divIcon({
            className: 'rider-marker-icon',
            html: `<div class="rider-arrow-container"><div class="rider-pulse"></div><div id="rider-arrow" class="rider-arrow"></div></div>`,
            iconSize: [80, 80],
            iconAnchor: [40, 40]
          }),
          zIndexOffset: 1000
        }).addTo(mapRef.current);
      } else {
        markerRef.current.setLatLng([finalPos.lat, finalPos.lng]);
        const el = document.getElementById('rider-arrow');
        // Use immediate heading value for smooth visual updates
        const displayHeading = finalHeading !== null ? finalHeading : (pendingHeadingRef.current !== null ? pendingHeadingRef.current : heading);
        if (el) el.style.transform = `rotate(${displayHeading}deg)`;
      }

      if (isFollowingRef.current) {
        let viewCenter = [finalPos.lat, finalPos.lng];
        if (appStatusRef.current === AppStatus.NAVIGATING) {
          const zoom = zoomLevelRef.current;
          const currentHeading = finalHeading !== null ? finalHeading : heading;
          const metersPerPixel = (156543.03392 * Math.cos(finalPos.lat * Math.PI / 180)) / Math.pow(2, zoom);
          
          // In portrait mode, offset the map center so rider appears at 75% down the screen
          // In landscape, keep rider centered
          const pixelOffset = (window.innerHeight > window.innerWidth) 
            ? (window.innerHeight * 0.25) / 1.7 
            : 0;
          
          const distanceMeters = pixelOffset * metersPerPixel;
          const earthRadius = 6378137;
          
          // Move map center NORTH (opposite of heading) so rider appears lower on screen
          const dLat = (distanceMeters * Math.cos(currentHeading * Math.PI / 180)) / earthRadius;
          const dLng = (distanceMeters * Math.sin(currentHeading * Math.PI / 180)) / (earthRadius * Math.cos(finalPos.lat * Math.PI / 180));
          
          if (!isNaN(dLat) && !isNaN(dLng)) {
            viewCenter = [finalPos.lat + dLat * (180 / Math.PI), finalPos.lng + dLng * (180 / Math.PI)];
          }
        }
        mapRef.current.setView(viewCenter, zoomLevelRef.current, { animate: false });
      }
    }
  }, [mapLoaded, heading, updateRouteVisuals]);

  useEffect(() => {
    if (mapLoaded) {
      updateWaypointMarkers();
    }
  }, [mapLoaded, stops, updateWaypointMarkers]);

  // Create global function for popup button to call
  useEffect(() => {
    (window as any).removeWaypoint = (index: number) => {
      const newStops = stops.filter((_, i) => i !== index);
      setStops(newStops);
      
      // Close any open popups
      if (mapRef.current) {
        mapRef.current.closePopup();
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
                if (routeLayerAheadRef.current) mapRef.current.removeLayer(routeLayerAheadRef.current);
                if (routeLayerBehindRef.current) mapRef.current.removeLayer(routeLayerBehindRef.current);
                routeLayerAheadRef.current = L.polyline(res.polyline.map(p => [p.lat, p.lng]), {
                  color: '#3b82f6', weight: 8, opacity: 0.85, lineJoin: 'round'
                }).addTo(mapRef.current);
                const bounds = L.latLngBounds(res.polyline.map(p => [p.lat, p.lng]));
                mapRef.current.fitBounds(bounds, { padding: [50, 50] });
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
    if (!mapContainerRef.current || typeof L === 'undefined') return;
    const timer = setTimeout(() => {
      if (mapRef.current) return;
      mapRef.current = L.map(mapContainerRef.current, {
        zoomControl: false,
        attributionControl: false,
        zoomAnimation: true,
        fadeAnimation: false,
        inertia: true
      }).setView([52.1326, 5.2913], 7);

      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        className: 'map-tiles'
      }).addTo(mapRef.current);

      setMapLoaded(true);
      mapRef.current.on('dragstart', () => setIsFollowing(false));
      mapRef.current.on('zoomend', () => setZoomLevel(mapRef.current.getZoom()));
    }, 100);
    return () => { if (mapRef.current) mapRef.current.remove(); };
  }, []);

  // Transform Origin: Always use 50% 50% to keep rider horizontally centered during rotation
  // Vertical positioning is handled by offsetting the map center in setView
  const mapTransformStyles = useMemo(() => {
    if (appStatus === AppStatus.NAVIGATING && isFollowing) {
      return {
        transform: `perspective(1200px) rotateX(65deg) rotateZ(${-heading}deg) scale(1.7)`,
        transformOrigin: `50% 50%`,
        willChange: 'transform'  // Performance: GPU acceleration hint
      };
    }
    return {
      transform: `perspective(1200px) rotateX(0deg) rotateZ(0deg) scale(1.0)`,
      transformOrigin: `50% 50%`
    };
  }, [appStatus, isFollowing, heading]);

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
        mapRef.current.setView([newPos.lat, newPos.lng], 15);
      }
    } catch (err: any) {
      console.error('GPS permission error:', err);
      if (err.code === 1) { // PERMISSION_DENIED
        setGpsPermissionDenied(true);
        alert('Please enable location access:\n\n1. Open iPhone Settings\n2. Scroll to Safari\n3. Tap Location\n4. Select "Allow"\n\nThen refresh this page.');
      } else if (err.code === 2) { // POSITION_UNAVAILABLE
        alert('Location unavailable. Please check your device settings.');
      } else if (err.code === 3) { // TIMEOUT
        alert('Location request timed out. Please try again.');
      }
    }
  };

  const startSimulation = () => {
    if (!route || route.polyline.length < 2) return;
    if (routeLayerAheadRef.current) mapRef.current?.removeLayer(routeLayerAheadRef.current);
    if (routeLayerBehindRef.current) mapRef.current?.removeLayer(routeLayerBehindRef.current);
    routeLayerAheadRef.current = null;
    routeLayerBehindRef.current = null;

    setIsSimulating(true);
    setIsFollowing(true);
    setAppStatus(AppStatus.NAVIGATING);
    setZoomLevel(17.5);
    distanceRef.current = 0;
    setCurrentManeuverIndex(0);

    if (simIntervalRef.current) cancelAnimationFrame(simIntervalRef.current);

    const poly = route.polyline;
    const totalDist = poly.reduce((acc, p, i) => i === 0 ? 0 : acc + getDistance(poly[i - 1], p), 0);
    const SPEED_FACTOR = 0.0000065;

    // Calculate cumulative distances for maneuvers
    const maneuverDistances: number[] = [];
    let cumulativeDist = 0;
    route.maneuvers.forEach(m => {
      maneuverDistances.push(cumulativeDist);
      cumulativeDist += m.distance;
    });

    let lastManeuverIndex = 0;
    let frameCount = 0;

    const animate = () => {
      frameCount++;
      // Performance: Run at 30 FPS instead of 60 FPS
      if (frameCount % 2 !== 0) {
        simIntervalRef.current = requestAnimationFrame(animate);
        return;
      }
      
      distanceRef.current += SPEED_FACTOR;
      if (distanceRef.current >= totalDist) {
        stopSimulation();
        setAppStatus(AppStatus.ARRIVED);
        return;
      }

      // Update current maneuver only every 10 frames to reduce re-renders
      if (frameCount % 10 === 0) {
        const traveledMeters = (distanceRef.current / totalDist) * route.distance;
        let newManeuverIndex = 0;
        for (let i = 0; i < maneuverDistances.length; i++) {
          if (traveledMeters >= maneuverDistances[i]) {
            newManeuverIndex = i;
          } else {
            break;
          }
        }
        if (newManeuverIndex !== lastManeuverIndex) {
          setCurrentManeuverIndex(newManeuverIndex);
          lastManeuverIndex = newManeuverIndex;
        }
      }

      let accumulated = 0, segIdx = 0;
      for (let i = 0; i < poly.length - 1; i++) {
        const d = getDistance(poly[i], poly[i + 1]);
        if (accumulated + d >= distanceRef.current) { segIdx = i; break; }
        accumulated += d;
      }

      const prog = (distanceRef.current - accumulated) / getDistance(poly[segIdx], poly[segIdx + 1]);
      const currentLoc = interpolate(poly[segIdx], poly[segIdx + 1], prog);
      const bearing = calculateBearing(poly[segIdx], poly[segIdx + 1]);
      
      // Update speed only every 20 frames to reduce re-renders
      const speedValue = frameCount % 20 === 0 ? 85 : speed;
      
      updateRiderLocation(currentLoc, bearing, speedValue);

      simIntervalRef.current = requestAnimationFrame(animate);
    };

    simIntervalRef.current = requestAnimationFrame(animate);
  };

  const stopSimulation = () => {
    setIsSimulating(false);
    if (simIntervalRef.current) cancelAnimationFrame(simIntervalRef.current);
    if (routeLayerAheadRef.current) mapRef.current?.removeLayer(routeLayerAheadRef.current);
    if (routeLayerBehindRef.current) mapRef.current?.removeLayer(routeLayerBehindRef.current);
    routeLayerAheadRef.current = null;
    routeLayerBehindRef.current = null;
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
        if (routeLayerAheadRef.current) mapRef.current.removeLayer(routeLayerAheadRef.current);
        routeLayerAheadRef.current = L.polyline(res.polyline.map(p => [p.lat, p.lng]), {
          color: '#3b82f6',
          weight: 8,
          opacity: 0.8,
          lineJoin: 'round'
        }).addTo(mapRef.current);
        mapRef.current.fitBounds(routeLayerAheadRef.current.getBounds(), { padding: [100, 100] });
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
      mapRef.current.flyTo([currentPos.lat, currentPos.lng], 15);
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
      mapRef.current.flyTo([coord.lat, coord.lng], 15);
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
            .map(s => [s.coord!.lat, s.coord!.lng]);
          
          if (coords.length > 0) {
            const bounds = L.latLngBounds(coords);
            mapRef.current.fitBounds(bounds, { padding: [50, 50] });
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
    <div className="flex h-screen w-full relative bg-slate-50 font-sans overflow-hidden">
      <div className="map-wrapper" style={mapTransformStyles}>
        <div ref={mapContainerRef} className="h-full w-full bg-slate-50" />
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
                <h3 className="font-bold text-slate-800 text-sm mb-1">GPS Permission Required</h3>
                <p className="text-xs text-slate-600 mb-3">Enable location access to use navigation features</p>
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
          className={`w-9 h-9 glass-panel rounded-xl flex items-center justify-center text-slate-700 hover:text-blue-500 font-bold text-lg shadow-lg transition-all active:scale-90 ${!isUIVisible ? 'opacity-0 pointer-events-none' : ''}`}
        >+</button>
        <button 
          onClick={() => setIsUIVisible(!isUIVisible)}
          className="w-9 h-9 glass-panel rounded-xl flex items-center justify-center text-slate-700 hover:text-blue-500 shadow-lg transition-all active:scale-90"
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
          className={`w-9 h-9 glass-panel rounded-xl flex items-center justify-center text-slate-700 hover:text-blue-500 font-bold text-lg shadow-lg transition-all active:scale-90 ${!isUIVisible ? 'opacity-0 pointer-events-none' : ''}`}
        >−</button>
      </div>

      <div className={`absolute inset-0 pointer-events-none transition-opacity duration-300 ${isUIVisible ? 'opacity-100' : 'opacity-0'}`}>
        <div className={`${isUIVisible ? 'pointer-events-auto' : 'pointer-events-none'}`}>

      <div className="absolute top-3 right-3 z-[100] flex flex-col items-end gap-1.5 pointer-events-none">
        <div className="glass-panel px-2 py-1 rounded-full flex items-center gap-1.5 pointer-events-auto shadow-md">
          <div className={(gpsActive || isSimulating) ? "signal-dot" : "w-1.5 h-1.5 bg-slate-300 rounded-full"} />
          <span className="text-[8px] font-black uppercase tracking-widest text-slate-600">
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
              <h2 className="text-sm font-bold text-slate-800 tracking-tight truncate">{route.maneuvers[currentManeuverIndex]?.instruction || "Continue ahead"}</h2>
              <p className="text-blue-500 font-medium text-[10px] uppercase tracking-wider">
                {currentManeuverIndex < route.maneuvers.length - 1 
                  ? `In ${Math.round(route.maneuvers[currentManeuverIndex]?.distance || 0)}m`
                  : 'Ride Smoothly to Destination'}
              </p>
            </div>
          </div>
        ) : (
          appStatus !== AppStatus.NAVIGATING && (
            <div className="flex flex-col gap-2">
              <div className="glass-panel p-3 rounded-2xl flex flex-col gap-2 shadow-xl relative">
                <h3 className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] mb-0.5">Planned Route</h3>
                {stops.map((stop, index) => (
                  <div key={stop.id} className="relative">
                    <div className="flex items-center gap-2">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${stop.coord ? 'bg-blue-500 text-white' : 'bg-slate-100 text-slate-400'}`}>
                        {index === 0 ? "A" : index === stops.length - 1 ? "B" : index}
                      </div>
                      <input
                        className="flex-grow bg-slate-50/50 rounded-lg px-3 py-2 border border-slate-100 text-base outline-none text-slate-700 font-bold focus:bg-white focus:border-blue-200 transition-all placeholder:text-slate-300"
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
                                  <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0013 3.06V1h-2v2.06A8.994 8.994 0 003.06 11H1v2h2.06A8.994 8.994 0 0011 20.94V23h2v-2.06A8.994 8.994 0 0020.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/>
                                </svg>
                                <div className="font-bold text-slate-800 text-xs group-hover:text-blue-600">
                                  My Location
                                </div>
                              </div>
                              <div className="text-[10px] text-slate-400 mt-0.5 ml-6">
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
                              <div className="font-bold text-slate-800 text-xs truncate group-hover:text-blue-600">
                                {streetName}
                              </div>
                              {(city || country) && (
                                <div className="text-[10px] text-slate-400 mt-0.5 truncate">
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
                    className="w-full py-1.5 text-[9px] font-black text-slate-400 hover:text-purple-500 uppercase tracking-widest transition-all hover:bg-purple-50/50 rounded-lg active:scale-95 flex items-center justify-center gap-1.5"
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
                    className="w-full py-1.5 text-[9px] font-black text-slate-400 hover:text-blue-500 uppercase tracking-widest transition-all hover:bg-blue-50/50 rounded-lg active:scale-95 flex items-center justify-center gap-1.5"
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
                    <button key={mode} onClick={() => { setSelectedMode(mode); handlePlanRide(mode); }} className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg text-[9px] font-black uppercase transition-all min-w-[75px] active:scale-95 ${selectedMode === mode ? 'bg-blue-500 text-white shadow-md' : 'bg-white/50 text-slate-500 hover:bg-white'}`}>
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
            <button onClick={() => { setIsFollowing(true); setZoomLevel(17.5); }} className="glass-panel px-4 py-2 rounded-full flex items-center gap-2 text-blue-600 font-black text-[9px] uppercase tracking-widest shadow-xl hover:bg-white transition-all active:scale-95">CENTER ON RIDER</button>
          </div>
        )}

        {appStatus === AppStatus.CONFIRM && route && (
          <div className="glass-panel p-4 rounded-2xl mb-3 animate-in slide-in-from-bottom duration-700 shadow-xl border-blue-50">
            <div className="flex justify-around mb-4 bg-slate-50/50 py-3 rounded-xl">
              <div className="text-center"><p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Curves</p><p className="text-base font-bold text-blue-500">{route.stats.curvatureIndex}/10</p></div>
              <div className="text-center border-x border-slate-100 px-6"><p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Time</p><p className="text-base font-bold text-slate-700">{Math.round(route.duration / 60)}m</p></div>
              <div className="text-center"><p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Scenic</p><p className="text-base font-bold text-emerald-500">{route.stats.scenicIndex}/10</p></div>
            </div>
            <div className="flex flex-col gap-2">
              <button onClick={() => { setAppStatus(AppStatus.NAVIGATING); setIsFollowing(true); setZoomLevel(17.5); }} className="w-full py-3 bg-blue-500 rounded-xl font-black text-white shadow-md uppercase tracking-widest text-[10px] active:scale-95 transition-all">Start Real Ride</button>
              <button onClick={startSimulation} className="w-full py-3 bg-slate-800 rounded-xl font-black text-white shadow-md uppercase tracking-widest text-[10px] active:scale-95 transition-all">Realistic Simulation</button>
              <button onClick={() => { setRoute(null); setAppStatus(AppStatus.IDLE); }} className="w-full py-1.5 text-[9px] font-black text-slate-400 uppercase tracking-widest">Adjust</button>
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
              <button onClick={() => { setAppStatus(AppStatus.NAVIGATING); setIsFollowing(true); setZoomLevel(17.5); }} className="w-full py-3 bg-slate-800 text-white rounded-2xl font-black shadow-xl flex items-center justify-center gap-3 active:scale-95 transition-all">
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
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-0.5">{route ? "ETA" : "Status"}</p>
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