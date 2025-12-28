
export enum RoutingMode {
  FAST = 'fast',
  BALANCED = 'balanced',
  CURVY = 'curvy'
}

export enum AppStatus {
  IDLE = 'idle',
  PREVIEW = 'preview',
  CONFIRM = 'confirm',
  NAVIGATING = 'navigating',
  REROUTING = 'rerouting',
  ARRIVED = 'arrived',
  ERROR = 'error'
}

export interface Avoidances {
  highways: boolean;
  sand: boolean;
  tolls: boolean;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Maneuver {
  instruction: string;
  distance: number;
  type: 'turn-left' | 'turn-right' | 'straight' | 'u-turn' | 'arrive' | 'sharp-left' | 'sharp-right' | 'slight-left' | 'slight-right' | 'merge-left' | 'merge-right' | 'exit-left' | 'exit-right' | 'fork-left' | 'fork-right' | 'roundabout-left' | 'roundabout-right' | 'u-turn-left' | 'u-turn-right';
  location?: LatLng;
  roadName?: string;
}

export interface RouteResponse {
  polyline: LatLng[];
  distance: number;
  duration: number;
  maneuvers: Maneuver[];
  stats: {
    curvatureIndex: number;
    scenicIndex: number;
  };
  warnings: string[];
  optimizedOrder?: number[];
}

export interface NavigationState {
  isNavigating: boolean;
  currentStepIndex: number;
  progress: number;
  remainingDistance: number;
  remainingTime: number;
}
