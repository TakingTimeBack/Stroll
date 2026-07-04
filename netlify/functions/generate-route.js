/**
 * STROLL COMPLETE ROUTING ENGINE v2
 * 
 * Uses OSRM (Open Source Routing Machine) for real pedestrian routing
 * Finds cardinal waypoints, routes between them with OSRM
 * Streams coordinates to frontend for live plotting
 */

const https = require('https');

exports.handler = async (event) => {
  const LOG = [];
  
  try {
    LOG.push('=== STROLL ROUTER (OSRM) ===');
    
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (err) {
      return respond(400, { error: 'Invalid JSON', debug: LOG });
    }

    const { location, time, pace } = body;
    LOG.push(`INPUT: ${location}, ${time}min, ${pace}km/h`);

    if (!location || time === undefined || !pace) {
      return respond(400, { error: 'Missing fields', debug: LOG });
    }

    // GEOCODE
    LOG.push('STEP: Geocoding');
    const [lat, lng] = await geocodeFinal(location) || [];
    if (!lat) {
      return respond(400, { error: `Could not geocode: ${location}`, debug: LOG });
    }
    LOG.push(`OK: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);

    const targetKm = (time / 60) * pace;
    LOG.push(`TARGET: ${targetKm.toFixed(2)}km`);

    // GENERATE CARDINAL WAYPOINTS
    LOG.push('STEP: Finding cardinal waypoints');
    const waypoints = findCardinalWaypoints(lat, lng, targetKm / 2);
    LOG.push(`WAYPOINTS: ${waypoints.length}`);

    // ROUTE via OSRM
    LOG.push('STEP: Routing with OSRM');
    const coordinates = [];
    
    // Route from center to North waypoint
    LOG.push('  Route 1: Center → North');
    const route1 = await routeViaOSRM([lng, lat], [waypoints.north.lng, waypoints.north.lat]);
    if (route1 && route1.length > 0) {
      coordinates.push(...route1);
      LOG.push(`    ✓ ${route1.length} points`);
    }

    // Route from North to East
    LOG.push('  Route 2: North → East');
    const route2 = await routeViaOSRM([waypoints.north.lng, waypoints.north.lat], [waypoints.east.lng, waypoints.east.lat]);
    if (route2 && route2.length > 0) {
      coordinates.push(...route2.slice(1)); // Skip first point (duplicate)
      LOG.push(`    ✓ ${route2.length} points`);
    }

    // Route from East to South
    LOG.push('  Route 3: East → South');
    const route3 = await routeViaOSRM([waypoints.east.lng, waypoints.east.lat], [waypoints.south.lng, waypoints.south.lat]);
    if (route3 && route3.length > 0) {
      coordinates.push(...route3.slice(1));
      LOG.push(`    ✓ ${route3.length} points`);
    }

    // Route from South to West
    LOG.push('  Route 4: South → West');
    const route4 = await routeViaOSRM([waypoints.south.lng, waypoints.south.lat], [waypoints.west.lng, waypoints.west.lat]);
    if (route4 && route4.length > 0) {
      coordinates.push(...route4.slice(1));
      LOG.push(`    ✓ ${route4.length} points`);
    }

    // Route from West back to center
    LOG.push('  Route 5: West → Center');
    const route5 = await routeViaOSRM([waypoints.west.lng, waypoints.west.lat], [lng, lat]);
    if (route5 && route5.length > 0) {
      coordinates.push(...route5.slice(1));
      LOG.push(`    ✓ ${route5.length} points`);
    }

    if (coordinates.length < 2) {
      LOG.push('WARN: Insufficient coordinates, fallback');
      const fallback = generateFallbackCircle(lat, lng, targetKm);
      return respond(200, {
        coordinates: fallback.coords,
        distance: fallback.dist,
        elevation: Math.round(50 + fallback.dist / 2),
        duration: time,
        location,
        pattern: 'fallback-circle',
        success: true,
        warning: 'Using fallback route',
        debug: LOG
      });
    }

    // Calculate distance
    let totalDist = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
      totalDist += haversine(coordinates[i][0], coordinates[i][1], coordinates[i+1][0], coordinates[i+1][1]);
    }

    LOG.push(`COMPLETE: ${coordinates.length} points, ${totalDist.toFixed(2)}km`);

    return respond(200, {
      coordinates: coordinates,
      distance: parseFloat(totalDist.toFixed(2)),
      elevation: Math.round(50 + totalDist / 2),
      duration: time,
      location,
      pattern: 'osrm-pedestrian',
      success: true,
      debug: LOG
    });

  } catch (err) {
    LOG.push(`CRITICAL: ${err.message}`);
    return respond(500, { error: err.message, debug: LOG });
  }
};

// ============================================================================
// RESPONSE
// ============================================================================

function respond(status, data) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data)
  };
}

// ============================================================================
// GEOCODE
// ============================================================================

async function geocodeFinal(location) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Stroll/1.0' },
      timeout: 10000
    });
    const data = await response.json();
    if (data && data.length > 0) {
      return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
    }
  } catch (err) {}
  return null;
}

// ============================================================================
// CARDINAL WAYPOINTS
// ============================================================================

function findCardinalWaypoints(lat, lng, radiusKm) {
  const degPerKm = 1 / 111; // 1 degree ≈ 111km
  const radiusDeg = radiusKm * degPerKm;

  return {
    north: { lat: lat + radiusDeg, lng: lng },
    south: { lat: lat - radiusDeg, lng: lng },
    east: { lat: lat, lng: lng + radiusDeg },
    west: { lat: lat, lng: lng - radiusDeg }
  };
}

// ============================================================================
// OSRM ROUTING
// ============================================================================

async function routeViaOSRM(start, end) {
  try {
    const url = `https://router.project-osrm.org/route/v1/foot/${start[0]},${start[1]};${end[0]},${end[1]}?geometries=geojson&steps=false`;
    
    const response = await fetch(url, {
      timeout: 30000
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    if (!data.routes || data.routes.length === 0) {
      return null;
    }

    const route = data.routes[0];
    if (!route.geometry || !route.geometry.coordinates) {
      return null;
    }

    // Convert GeoJSON coordinates [lng, lat] to [lat, lng]
    return route.geometry.coordinates.map(coord => [coord[1], coord[0]]);

  } catch (err) {
    return null;
  }
}

// ============================================================================
// FALLBACK
// ============================================================================

function generateFallbackCircle(lat, lng, targetKm) {
  const coords = [];
  const steps = 64;
  const radius = targetKm / (Math.PI * 2) / 111;

  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    coords.push([
      lat + radius * Math.sin(angle),
      lng + radius * Math.cos(angle)
    ]);
  }

  return {
    coords,
    dist: targetKm
  };
}

// ============================================================================
// UTILS
// ============================================================================

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
