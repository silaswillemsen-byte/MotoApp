import { GoogleGenAI, Type } from "@google/genai";
import { RoutingMode, Avoidances, LatLng, RouteResponse, Maneuver } from "../types";

/**
 * Decodes OSRM Polyline5
 */
const decodePolyline = (encoded: string): LatLng[] => {
  let index = 0, len = encoded.length;
  let lat = 0, lng = 0;
  const coordinates: LatLng[] = [];

  while (index < len) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    coordinates.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return coordinates;
};

/**
 * Generates an intermediate target coordinate to pull the route toward curves.
 */
const generateCurvyTarget = (start: LatLng, end: LatLng, mode: RoutingMode): LatLng | null => {
  if (mode !== RoutingMode.CURVY) return null;

  const midLat = (start.lat + end.lat) / 2;
  const midLng = (start.lng + end.lng) / 2;

  const dLat = end.lat - start.lat;
  const dLng = end.lng - start.lng;

  // Perpendicular vector for offset
  const pLat = -dLng;
  const pLng = dLat;

  const factor = 0.15; // Slightly reduced factor for stability
  return {
    lat: midLat + (pLat * factor),
    lng: midLng + (pLng * factor)
  };
};

const buildRoadName = (step: any): string => {
  const name = step?.name && step.name !== 'unnamed road' ? step.name : '';
  const ref = step?.ref || '';
  if (name && ref && !name.includes(ref)) return `${name} (${ref})`;
  return name || ref || '';
};

const buildInstruction = (step: any): string => {
  const maneuver = step?.maneuver || {};
  if (maneuver.instruction) return maneuver.instruction;

  const roadName = buildRoadName(step);
  const hasRoad = roadName.length > 0;
  const onRoad = hasRoad ? ` on ${roadName}` : '';
  const ontoRoad = hasRoad ? ` onto ${roadName}` : '';
  const modifier = maneuver.modifier;

  switch (maneuver.type) {
    case 'depart':
      if (modifier) return `Head ${modifier}${onRoad}`;
      return hasRoad ? `Head on ${roadName}` : 'Head out';
    case 'turn':
      if (modifier === 'straight') return `Continue straight${onRoad}`;
      if (modifier) return `Turn ${modifier}${ontoRoad}`;
      return hasRoad ? `Turn${ontoRoad}` : 'Turn';
    case 'continue':
    case 'new name':
      return hasRoad ? `Continue on ${roadName}` : 'Continue';
    case 'merge':
      if (modifier) return `Merge ${modifier}${ontoRoad}`;
      return hasRoad ? `Merge onto ${roadName}` : 'Merge';
    case 'on ramp':
      return hasRoad ? `Take the ramp to ${roadName}` : 'Take the ramp';
    case 'off ramp':
      return hasRoad ? `Take the exit toward ${roadName}` : 'Take the exit';
    case 'fork':
      if (modifier) return `Keep ${modifier}${onRoad}`;
      return hasRoad ? `Keep toward ${roadName}` : 'Keep right';
    case 'roundabout':
    case 'rotary':
      if (maneuver.exit) return `At the roundabout, take exit ${maneuver.exit}${ontoRoad}`;
      return hasRoad ? `Enter the roundabout toward ${roadName}` : 'Enter the roundabout';
    case 'arrive':
      return 'Arrive at destination';
    default:
      if (maneuver.type && maneuver.type.includes('uturn')) {
        return modifier === 'left' ? 'Make a U-turn left' : 'Make a U-turn right';
      }
      return hasRoad ? `Continue on ${roadName}` : 'Continue';
  }
};

const fetchRoute = async (stops: LatLng[], mode: RoutingMode): Promise<any> => {
  const sequence: LatLng[] = [];
  const radiusValues: number[] = [];

  for (let i = 0; i < stops.length - 1; i++) {
    sequence.push(stops[i]);
    radiusValues.push(100); // Standard snap

    const target = generateCurvyTarget(stops[i], stops[i + 1], mode);
    if (target) {
      sequence.push(target);
      radiusValues.push(2000); // Wide snap for hint points
    }
  }

  sequence.push(stops[stops.length - 1]);
  radiusValues.push(100);

  const allCoords = sequence.map(p => `${p.lng},${p.lat}`).join(';');
  const radiusesStr = radiusValues.join(';');
  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${allCoords}?overview=full&geometries=polyline&steps=true&radiuses=${radiusesStr}&continue_straight=true`;

  const response = await fetch(osrmUrl);
  return await response.json();
};

export const calculateRoute = async (
  stops: LatLng[],
  mode: RoutingMode,
  avoid: Avoidances,
  optimizeOrder: boolean = false
): Promise<RouteResponse> => {
  if (stops.length < 2) throw new Error("At least 2 points are required for routing.");

  let finalStops = [...stops];
  let optimizedOrder: number[] | undefined;

  // 1. Order Optimization (Only for Fast/Balanced)
  if (optimizeOrder && stops.length > 2 && mode !== RoutingMode.CURVY) {
    const coords = stops.map(s => `${s.lng},${s.lat}`).join(';');
    const tripUrl = `https://router.project-osrm.org/trip/v1/driving/${coords}?source=first&destination=last&roundtrip=false&geometries=polyline`;
    try {
      const tripRes = await fetch(tripUrl);
      const tripData = await tripRes.json();

      if (tripData.code === 'Ok' && tripData.waypoints) {
        optimizedOrder = tripData.waypoints
          .sort((a: any, b: any) => a.waypoint_index - b.waypoint_index)
          .map((w: any) => w.trips_index);

        const reordered: LatLng[] = new Array(stops.length);
        tripData.waypoints.forEach((w: any) => {
          reordered[w.waypoint_index] = stops[w.trips_index];
        });
        finalStops = reordered;
      }
    } catch (e) {
      console.warn("Optimization failed, using original order", e);
    }
  }

  // 2. Fetch Route (with Retry Logic)
  let osrmData;
  let usedMode = mode;

  try {
    osrmData = await fetchRoute(finalStops, mode);
    if (osrmData.code !== 'Ok') throw new Error(osrmData.code);
  } catch (error) {
    // If Curvy mode fails, retry with Balanced (no intermediate points)
    if (mode === RoutingMode.CURVY) {
      console.warn('Curvy routing failed, falling back to Balanced mode.');
      usedMode = RoutingMode.BALANCED;
      osrmData = await fetchRoute(finalStops, RoutingMode.BALANCED);
    } else {
      throw error;
    }
  }

  if (!osrmData || osrmData.code !== 'Ok') {
    throw new Error(`Route calculation failed: ${osrmData?.message || osrmData?.code || 'Unknown Error'}`);
  }

  const bestRoute = osrmData.routes[0];
  const fullPath = decodePolyline(bestRoute.geometry);

  if (fullPath.length === 0) {
    throw new Error("Route calculation returned empty path.");
  }

  // 4. AI Analysis & Scoring
  const apiKey = process.env.API_KEY;
  let aiStats = {
    curvatureIndex: usedMode === RoutingMode.CURVY ? 8 : 4,
    scenicIndex: 6,
    warnings: ["Live analysis unavailable. Enjoy the ride!"]
  };

  // Update AI prompt to reflect actual used mode needed? 
  // Probably keep original intent or update. Let's update stats base.

  if (apiKey) {
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `Analyze this multi-stop motorcycle journey. Mode: ${usedMode.toUpperCase()}. Total distance: ${Math.round(bestRoute.distance / 1000)}km. Provide curvatureIndex (1-10), scenicIndex (1-10), and 3 motorcycle safety tips for this terrain.`;

    try {
      const aiResponse = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              curvatureIndex: { type: Type.NUMBER },
              scenicIndex: { type: Type.NUMBER },
              warnings: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["curvatureIndex", "scenicIndex", "warnings"]
          }
        }
      });
      aiStats = JSON.parse(aiResponse.text || "{}");
    } catch (e) {
      console.warn("AI Analysis failed, using fallbacks", e);
    }
  } else {
    // Generate deterministic "randomness" based on distance
    const seed = Math.floor(bestRoute.distance);
    aiStats = {
      curvatureIndex: usedMode === RoutingMode.CURVY ? 7 + (seed % 3) : 3 + (seed % 3),
      scenicIndex: 5 + (seed % 5),
      warnings: [
        "Ride safe and enjoy the open road!",
        "Watch out for varying road conditions.",
        "Keep a safe distance from other vehicles."
      ]
    };
  }

  const maneuvers: Maneuver[] = [];
  bestRoute.legs.forEach((leg: any) => {
    leg.steps.forEach((step: any) => {
      const maneuverType = step.maneuver.type;
      const modifier = step.maneuver.modifier;
      const roadName = buildRoadName(step);
      const maneuverLocation = Array.isArray(step.maneuver?.location)
        ? { lng: step.maneuver.location[0], lat: step.maneuver.location[1] }
        : undefined;

      let iconType: 'turn-left' | 'turn-right' | 'straight' | 'u-turn' | 'arrive' | 'sharp-left' | 'sharp-right' | 'slight-left' | 'slight-right' | 'merge-left' | 'merge-right' | 'exit-left' | 'exit-right' | 'fork-left' | 'fork-right' | 'roundabout-left' | 'roundabout-right' | 'u-turn-left' | 'u-turn-right' = 'straight';

      // Map OSRM maneuver types to our icon types
      if (maneuverType === 'turn') {
        if (modifier === 'sharp left') iconType = 'sharp-left';
        else if (modifier === 'sharp right') iconType = 'sharp-right';
        else if (modifier === 'left') iconType = 'turn-left';
        else if (modifier === 'right') iconType = 'turn-right';
        else if (modifier === 'slight left') iconType = 'slight-left';
        else if (modifier === 'slight right') iconType = 'slight-right';
      } else if (maneuverType === 'new name') {
        iconType = 'straight';
      } else if (maneuverType === 'depart') {
        iconType = 'straight';
      } else if (maneuverType === 'arrive') {
        iconType = 'arrive';
      } else if (maneuverType === 'merge') {
        iconType = modifier === 'left' ? 'merge-left' : 'merge-right';
      } else if (maneuverType === 'on ramp' || maneuverType === 'off ramp') {
        iconType = modifier === 'left' ? 'exit-left' : 'exit-right';
      } else if (maneuverType === 'fork') {
        iconType = modifier === 'left' ? 'fork-left' : 'fork-right';
      } else if (maneuverType === 'roundabout' || maneuverType === 'rotary') {
        iconType = modifier?.includes('left') ? 'roundabout-left' : 'roundabout-right';
      } else if (maneuverType === 'continue') {
        iconType = 'straight';
      } else if (maneuverType.includes('uturn')) {
        iconType = modifier === 'left' ? 'u-turn-left' : 'u-turn-right';
      }

      maneuvers.push({
        instruction: buildInstruction(step),
        distance: step.distance,
        type: iconType,
        location: maneuverLocation,
        roadName
      });
    });
  });

  if (maneuvers.length > 0 && maneuvers[maneuvers.length - 1].type !== 'arrive') {
    maneuvers.push({ instruction: "Destination reached", distance: 0, type: 'arrive' });
  }

  return {
    polyline: fullPath,
    distance: bestRoute.distance,
    duration: bestRoute.duration,
    maneuvers,
    stats: {
      curvatureIndex: aiStats.curvatureIndex || 5,
      scenicIndex: aiStats.scenicIndex || 5
    },
    warnings: aiStats.warnings || [],
    optimizedOrder
  };
};
