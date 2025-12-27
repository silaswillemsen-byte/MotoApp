import { LatLng } from '../types';

export interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  address?: {
    country_code?: string;
    country?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
  };
  type?: string;
}

export interface ReverseGeocodeResult {
  countryCode: string;
  address: any;
}

/**
 * Reverse-geocode a position to detect country code and address details.
 */
export async function reverseNominatim(
  pos: LatLng
): Promise<ReverseGeocodeResult | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${pos.lat}&lon=${pos.lng}&zoom=3&addressdetails=1`;
    const res = await fetch(url, {
      headers: { 'Accept-Language': navigator.language || 'en' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.address) return null;
    const countryCode = data.address.country_code || '';
    return { countryCode, address: data.address };
  } catch (e) {
    console.warn('Reverse geocode failed', e);
    return null;
  }
}

/**
 * Search Nominatim with local-aware biasing.
 * 
 * @param query - Search query string
 * @param center - Center point for viewbox bias
 * @param countryCode - Optional ISO country code (e.g., 'nl')
 * @param bounded - Restrict results to viewbox (default true; fallback to false if no results)
 * @param delta - Viewbox half-size in degrees (default 0.5 ≈ 55 km)
 * @param limit - Max results (default 6)
 * @returns Array of Nominatim results
 */
export async function searchNominatim(
  query: string,
  center: LatLng,
  countryCode?: string,
  bounded: boolean = true,
  delta: number = 0.5,
  limit: number = 6
): Promise<NominatimResult[]> {
  if (query.length < 2) return [];

  try {
    // Build viewbox: left,top,right,bottom (lon,lat order)
    const viewbox = `${center.lng - delta},${center.lat + delta},${center.lng + delta},${center.lat - delta}`;
    
    let url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&q=${encodeURIComponent(query)}&limit=${limit}&viewbox=${viewbox}&bounded=${bounded ? 1 : 0}`;
    
    if (countryCode) {
      url += `&countrycodes=${countryCode}`;
    }

    const res = await fetch(url, {
      headers: { 'Accept-Language': navigator.language || 'en' }
    });

    if (!res.ok) return [];
    const data = await res.json();

    // If bounded search yields no results, retry with bounded=0 (global bias)
    if (bounded && (!data || data.length === 0)) {
      console.log('No local results, retrying with global bias...');
      return searchNominatim(query, center, countryCode, false, delta, limit);
    }

    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('Nominatim search failed', e);
    return [];
  }
}
