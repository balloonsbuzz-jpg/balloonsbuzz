// Distance from the BalloonsBuzz base (Miyapur) to the venue.
// Default: straight line × road factor (no API key, no cost). With GOOGLE_MAPS_API_KEY:
// real driving distance from the Distance Matrix API, falling back to the estimate.
const { env } = require('../config/env');
const { query } = require('../db/pool');
const { conflict } = require('../lib/errors');
const logger = require('../lib/logger');

const R = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;

function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const round2 = (x) => Math.round(x * 100) / 100;

async function googleDrivingKm(from, to) {
  const qs = new URLSearchParams({
    origins: `${from.lat},${from.lng}`, destinations: `${to.lat},${to.lng}`, mode: 'driving', units: 'metric', key: env.GOOGLE_MAPS_API_KEY,
  });
  const res = await fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?${qs}`, { signal: AbortSignal.timeout(8000) });
  const j = await res.json();
  const el = j?.rows?.[0]?.elements?.[0];
  if (j.status !== 'OK' || el?.status !== 'OK') throw new Error(`Distance Matrix: ${j.status}/${el?.status}`);
  return el.distance.value / 1000;
}

async function baseLocation(tenantId) {
  const { rows: [s] } = await query(
    `SELECT base_lat, base_lng, base_address, road_factor, max_service_km FROM business_settings WHERE tenant_id = $1`, [tenantId]);
  if (!s || s.base_lat == null || s.base_lng == null) {
    throw conflict('The base location is not set yet. Add the Miyapur pin in Pricing & Rules → Distance.');
  }
  return {
    lat: Number(s.base_lat), lng: Number(s.base_lng), address: s.base_address,
    roadFactor: Number(s.road_factor), maxServiceKm: s.max_service_km == null ? null : Number(s.max_service_km),
  };
}

/**
 * @returns {{km:number, straight_km:number, method:'google'|'estimate', max_service_km:number|null}}
 */
async function distanceFromBase(tenantId, to) {
  if (!Number.isFinite(to?.lat) || !Number.isFinite(to?.lng) || Math.abs(to.lat) > 90 || Math.abs(to.lng) > 180) {
    throw conflict('Invalid venue location');
  }
  const base = await baseLocation(tenantId);
  const straight = haversineKm(base, to);
  if (env.GOOGLE_MAPS_API_KEY) {
    try {
      return { km: round2(await googleDrivingKm(base, to)), straight_km: round2(straight), method: 'google', max_service_km: base.maxServiceKm };
    } catch (err) {
      logger.warn('road distance lookup failed, using the estimate', { error: err.message });
    }
  }
  return { km: round2(straight * base.roadFactor), straight_km: round2(straight), method: 'estimate', max_service_km: base.maxServiceKm };
}

module.exports = { haversineKm, distanceFromBase, baseLocation };
