import { LatLng } from "../types";

interface StopInput {
  address: string;
  coord: LatLng | null;
  id: string;
}

interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a parsed GPX document
 */
export const validateGPX = (doc: Document): ValidationResult => {
  // Check for parser errors
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    return { valid: false, error: 'Invalid XML format. Please upload a valid .gpx file' };
  }

  // Check if root element is <gpx>
  const gpxRoot = doc.querySelector('gpx');
  if (!gpxRoot) {
    return { valid: false, error: 'Invalid file format. Root element must be <gpx>' };
  }

  // Check for at least one data type (route, waypoint, or track)
  const hasRoutes = doc.querySelectorAll('rte').length > 0;
  const hasWaypoints = doc.querySelectorAll('wpt').length > 0;
  const hasTracks = doc.querySelectorAll('trk').length > 0;

  if (!hasRoutes && !hasWaypoints && !hasTracks) {
    return { valid: false, error: 'GPX file contains no waypoints, routes, or tracks' };
  }

  return { valid: true };
};

/**
 * Validates coordinate values
 */
const isValidCoord = (lat: number, lng: number): boolean => {
  return (
    !isNaN(lat) && !isNaN(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  );
};

/**
 * Simplifies a track to target number of points using even spacing
 */
export const simplifyTrack = (points: LatLng[], targetCount: number = 50): LatLng[] => {
  if (points.length <= targetCount) return points;

  const simplified: LatLng[] = [points[0]]; // Always keep first point
  const step = Math.floor(points.length / (targetCount - 1));

  for (let i = step; i < points.length - 1; i += step) {
    simplified.push(points[i]);
  }

  simplified.push(points[points.length - 1]); // Always keep last point
  return simplified;
};

/**
 * Parses route points from <rte> elements
 */
const parseRoutes = (rte: Element): StopInput[] => {
  const rtepts = rte.querySelectorAll('rtept');
  const stops: StopInput[] = [];

  rtepts.forEach((rtept, index) => {
    const lat = parseFloat(rtept.getAttribute('lat') || '');
    const lon = parseFloat(rtept.getAttribute('lon') || '');

    if (!isValidCoord(lat, lon)) return;

    const nameEl = rtept.querySelector('name');
    const descEl = rtept.querySelector('desc');
    const name = nameEl?.textContent || descEl?.textContent || `Waypoint ${index + 1}`;

    stops.push({
      id: `gpx-route-${Date.now()}-${index}`,
      address: name.trim(),
      coord: { lat, lng: lon }
    });
  });

  return stops;
};

/**
 * Parses standalone waypoints from <wpt> elements
 */
const parseWaypoints = (waypoints: NodeListOf<Element>): StopInput[] => {
  const stops: StopInput[] = [];

  waypoints.forEach((wpt, index) => {
    const lat = parseFloat(wpt.getAttribute('lat') || '');
    const lon = parseFloat(wpt.getAttribute('lon') || '');

    if (!isValidCoord(lat, lon)) return;

    const nameEl = wpt.querySelector('name');
    const descEl = wpt.querySelector('desc');
    const name = nameEl?.textContent || descEl?.textContent || `Point ${index + 1}`;

    stops.push({
      id: `gpx-waypoint-${Date.now()}-${index}`,
      address: name.trim(),
      coord: { lat, lng: lon }
    });
  });

  return stops;
};

/**
 * Parses and simplifies track data from <trk> elements
 */
const parseAndSimplifyTrack = (trk: Element): StopInput[] => {
  const trkpts = trk.querySelectorAll('trkpt');
  const points: LatLng[] = [];

  trkpts.forEach((trkpt) => {
    const lat = parseFloat(trkpt.getAttribute('lat') || '');
    const lon = parseFloat(trkpt.getAttribute('lon') || '');

    if (isValidCoord(lat, lon)) {
      points.push({ lat, lng: lon });
    }
  });

  // Simplify if too many points
  const simplified = simplifyTrack(points, 50);

  // Convert to StopInput format
  return simplified.map((point, index) => ({
    id: `gpx-track-${Date.now()}-${index}`,
    address: index === 0 ? 'Track Start' : index === simplified.length - 1 ? 'Track End' : `Track Point ${index}`,
    coord: point
  }));
};

/**
 * Main GPX parser function
 * Parses GPX XML string and returns array of StopInput waypoints
 * Priority: Routes > Waypoints > Tracks (simplified)
 */
export const parseGPX = (xmlString: string): StopInput[] => {
  // Parse XML
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  // Validate
  const validation = validateGPX(doc);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Priority 1: Try to parse routes (best for waypoint navigation)
  const routes = doc.querySelectorAll('rte');
  if (routes.length > 0) {
    const stops = parseRoutes(routes[0]); // Use first route
    if (stops.length >= 2) return stops;
  }

  // Priority 2: Fall back to standalone waypoints
  const waypoints = doc.querySelectorAll('wpt');
  if (waypoints.length > 0) {
    const stops = parseWaypoints(waypoints);
    if (stops.length >= 2) return stops;
  }

  // Priority 3: Last resort - simplify track data
  const tracks = doc.querySelectorAll('trk');
  if (tracks.length > 0) {
    const stops = parseAndSimplifyTrack(tracks[0]);
    if (stops.length >= 2) return stops;
  }

  throw new Error('GPX file must contain at least 2 valid waypoints');
};
