
import React from 'react';

export const MANEUVER_ICONS = {
  'turn-left': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 20V10H4l8-8 8 8h-4v10H8z" transform="rotate(-90 12 12)"/>
    </svg>
  ),
  'turn-right': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 20V10H4l8-8 8 8h-4v10H8z" transform="rotate(90 12 12)"/>
    </svg>
  ),
  'slight-left': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l-8 8h5v10h6V10h5z" transform="rotate(-45 12 12)"/>
    </svg>
  ),
  'slight-right': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l-8 8h5v10h6V10h5z" transform="rotate(45 12 12)"/>
    </svg>
  ),
  'sharp-left': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
    </svg>
  ),
  'sharp-right': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4v-2z"/>
    </svg>
  ),
  'straight': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l-8 8h5v10h6V10h5z"/>
    </svg>
  ),
  'u-turn-left': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18 9v12h-2V9c0-2.21-1.79-4-4-4S8 6.79 8 9v4.17l1.59-1.59L11 13l-4 4-4-4 1.41-1.41L6 13.17V9c0-3.31 2.69-6 6-6s6 2.69 6 6z"/>
    </svg>
  ),
  'u-turn-right': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 9v12h2V9c0-2.21 1.79-4 4-4s4 1.79 4 4v4.17l-1.59-1.59L13 13l4 4 4-4-1.41-1.41L18 13.17V9c0-3.31-2.69-6-6-6S6 5.69 6 9z"/>
    </svg>
  ),
  'merge-left': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 21h2v-6c0-1.1.9-2 2-2h5l-2-2-2 2h-1c-2.21 0-4 1.79-4 4v4zm12-17h-2v6c0 1.1-.9 2-2 2h-5l2 2 2-2h1c2.21 0 4-1.79 4-4V4z"/>
    </svg>
  ),
  'merge-right': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18 21h-2v-6c0-1.1-.9-2-2-2h-5l2-2 2 2h1c2.21 0 4 1.79 4 4v4zM6 4h2v6c0 1.1.9 2 2 2h5l-2 2-2-2h-1c-2.21 0-4-1.79-4-4V4z"/>
    </svg>
  ),
  'roundabout-left': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/>
      <path d="M12 6l-4 4h3v4h2v-4h3z"/>
    </svg>
  ),
  'roundabout-right': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/>
      <path d="M12 6l4 4h-3v4h-2v-4H8z"/>
    </svg>
  ),
  'exit-left': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10l-4 4v-3H8v-2h5V9l4 4z"/>
    </svg>
  ),
  'exit-right': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8 14l-4-4 4-4v3h5v2h-5v3z"/>
    </svg>
  ),
  'arrive': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
    </svg>
  ),
  'fork-left': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l-8 8v2h5v8h2v-8h2v8h2v-8h5V10z" transform="rotate(-30 12 12)"/>
    </svg>
  ),
  'fork-right': (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l-8 8v2h5v8h2v-8h2v8h2v-8h5V10z" transform="rotate(30 12 12)"/>
    </svg>
  ),
};

export const RECENT_SEARCHES = [
  { name: 'Stelvio Pass', address: 'Italy' },
  { name: 'Route Napoléon', address: 'France' },
  { name: 'Grossglockner', address: 'Austria' },
  { name: 'Passo del Rombo', address: 'Italy/Austria' }
];
