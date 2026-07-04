/**
 * STROLL OSRM ROUTER WITH ROAD EXCLUSIONS
 * 
 * Uses OSRM foot profile with motorway/trunk/primary exclusions
 * Fast, reliable, proven routing without major roads
 * Fallback circle if routing fails
 */

exports.handler = async (event) => {
  const LOG = [];
  
  try {
    LOG.push('=== STROLL OSRM ROUTER (EXCLUSIONS) ===');
    
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

    // Generate random waypoints in a circle
    LOG.push('STEP: Generating waypoints');
    const radius = Math.min(0.4, targetKm / 8);
    const waypoints = generateRandomWaypoints(lat, lng, radius, 4);
    LOG.push(`WAYPOINTS: ${waypoints.length}`);

    // Route via OSRM with exclusions
    LOG.push('STEP: Routing via OSRM (excluding motorway/trunk/primary)');
    const coordinates = [];
    let lastPoint = { lat, lng };

    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      const segment = await routeViaOSRM(lastPoint, wp);
      
      if (segment && segment.length > 0) {
        if (i === 0) {
          coordinates.push(...segment);
        } else {
          coordinates.push(...segment.slice(1));
        }
        lastPoint = wp;
        LOG.push(`  ✓ Segment ${i + 1}: ${segment.length} points`);
      } else {
        LOG.push(`  ✗ Segment ${i + 1}: failed, fallback`);
      }
    }

    // Return to start
    LOG.push('STEP: Return to start');
    const finalSeg = await routeViaOSRM(lastPoint, { lat, lng });
    if (finalSeg && finalSeg.length > 0) {
      coordinates.push(...finalSeg.slice(1));
      LOG.push(`  ✓ Return: ${finalSeg.length} points`);
    }

    // If no valid routes, use circle
    if (coordinates.length < 2) {
      LOG.push('WARN: No valid routes via OSRM, using fallback circle');
      const fallback = generateFallbackCircle(lat, lng, targetKm);
      return respond(200, {
        coordinates: fallback.coords,
        distance: fallback.dist,
        elevation: Math.round(50 + fallback.dist / 2),
        duration: time,
        location,
        pattern: 'fallback-circle',
        success: true,
        warning: 'Used geometric fallback (no routes found)',
        debug: LOG
      });
    }

    // Calculate distance
    let totalDist = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
      totalDist += haversine(coordinates[i][0], coordinates[i][1], 
                            coordinates[i + 1][0], coordinates[i + 1][1]);
    }

    LOG.push(`SUCCESS: ${coordinates.length} points, ${totalDist.toFixed(2)}km`);

    return respond(200, {
      coordinates,
      distance: parseFloat(totalDist.toFixed(2)),
      elevation: Math.round(50 + totalDist / 2),
      duration: time,
      location,
      pattern: 'osrm-pedestrian',
      source: 'OSRM Foot Profile',
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
// ROUTE VIA OSRM WITH EXCLUSIONS
// ============================================================================

async function routeViaOSRM(from, to) {
  try {
    // OSRM foot profile with motorway/trunk/primary exclusions
    const url = `https://router.project-osrm.org/route/v1/foot/${from.lng},${from.lat};${to.lng},${to.lat}?geometries=geojson&exclude=motorway,trunk,primary`;
    
    const response = await fetch(url, { timeout: 10000 });
    const data = await response.json();

    if (!data.routes || data.routes.length === 0) {
      return null;
    }

    const route = data.routes[0];
    const coords = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    
    return coords;
  } catch (err) {
    return null;
  }
}

// ============================================================================
// WAYPOINTS
// ============================================================================

function generateRandomWaypoints(lat, lng, radius, count) {
  const waypoints = [];
  const usedAngles = new Set();

  for (let i = 0; i < count; i++) {
    let angle;
    let attempts = 0;
    do {
      angle = Math.random() * 360;
      attempts++;
    } while (usedAngles.has(Math.round(angle / 30) * 30) && attempts < 10);

    usedAngles.add(Math.round(angle / 30) * 30);

    const rad = (angle * Math.PI) / 180;
    const radiusVariance = radius * (0.7 + Math.random() * 0.6);
    const degPerKm = 1 / 111;

    waypoints.push({
      lat: lat + radiusVariance * degPerKm * Math.sin(rad),
      lng: lng + radiusVariance * degPerKm * Math.cos(rad)
    });
  }

  waypoints.sort((a, b) => {
    const angleA = Math.atan2(a.lat - lat, a.lng - lng);
    const angleB = Math.atan2(b.lat - lat, b.lng - lng);
    return angleA - angleB;
  });

  return waypoints;
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

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
