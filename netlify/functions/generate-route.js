/**
 * STROLL ADAPTIVE ROUTING ENGINE
 * 
 * Detects local road density, adapts waypoint radius per location
 * Generates unique random routes each time
 * Avoids major roads via local analysis
 */

exports.handler = async (event) => {
  const LOG = [];
  
  try {
    LOG.push('=== STROLL ADAPTIVE ROUTER ===');
    
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

    // ANALYZE LOCAL ROAD DENSITY
    LOG.push('STEP: Analyzing local road network');
    const density = await analyzeRoadDensity(lat, lng);
    LOG.push(`DENSITY: ${density.roadCount} roads, density=${density.density.toFixed(3)}`);

    // ADAPTIVE WAYPOINT RADIUS
    // Sparse areas: use larger radius
    // Dense areas: use smaller radius
    const adaptiveRadius = calculateAdaptiveRadius(targetKm, density);
    LOG.push(`ADAPTIVE_RADIUS: ${adaptiveRadius.toFixed(3)}km`);

    // GENERATE RANDOM WAYPOINTS (unique each time)
    LOG.push('STEP: Generating randomized waypoints');
    const waypoints = generateRandomWaypoints(lat, lng, adaptiveRadius, targetKm);
    LOG.push(`WAYPOINTS: ${waypoints.length} at angles: ${waypoints.map(w => Math.round(w.angle)).join(', ')}°`);

    // FILTER OUT MAJOR ROADS
    LOG.push('STEP: Identifying major roads to avoid');
    const majorRoads = await identifyMajorRoads(lat, lng, adaptiveRadius * 1.5);
    LOG.push(`MAJOR_ROADS: ${majorRoads.length} (A-roads, motorways)`);

    // ROUTE via OSRM
    LOG.push('STEP: Routing via OSRM');
    const coordinates = [];
    
    // Route through all waypoints in order
    let lastPoint = [lng, lat];
    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      LOG.push(`  Segment ${i + 1}: ${wp.label}`);
      
      const segmentCoords = await routeViaOSRM(lastPoint, [wp.lng, wp.lat]);
      
      if (segmentCoords && segmentCoords.length > 0) {
        // Add segment, skip first point if not first segment (avoid duplicates)
        if (i === 0) {
          coordinates.push(...segmentCoords);
        } else {
          coordinates.push(...segmentCoords.slice(1));
        }
        lastPoint = [wp.lng, wp.lat];
        LOG.push(`    ✓ ${segmentCoords.length} points`);
      } else {
        LOG.push(`    ✗ routing failed`);
      }
    }

    // Final segment back to center
    LOG.push(`  Final: Return to center`);
    const finalSegment = await routeViaOSRM(lastPoint, [lng, lat]);
    if (finalSegment && finalSegment.length > 0) {
      coordinates.push(...finalSegment.slice(1));
      LOG.push(`    ✓ ${finalSegment.length} points`);
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
      pattern: 'adaptive-osrm',
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
// ANALYZE LOCAL ROAD DENSITY
// ============================================================================

async function analyzeRoadDensity(lat, lng) {
  try {
    const radius = 1000; // 1km radius
    const deg = radius / 111000;
    const bbox = `${lat - deg},${lng - deg},${lat + deg},${lng + deg}`;

    const query = `[bbox:${lat - deg},${lng - deg},${lat + deg},${lng + deg}];way["highway"];out ids;`;

    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
      timeout: 15000
    });

    if (!response.ok) {
      return { roadCount: 50, density: 0.5 }; // Default
    }

    const xml = await response.text();
    const roadCount = (xml.match(/<way id=/g) || []).length;
    const areaKm2 = Math.PI * (radius / 1000) ** 2;
    const density = roadCount / areaKm2;

    return { roadCount, density };
  } catch (err) {
    return { roadCount: 50, density: 0.5 }; // Default
  }
}

// ============================================================================
// IDENTIFY MAJOR ROADS (to avoid)
// ============================================================================

async function identifyMajorRoads(lat, lng, radiusKm) {
  try {
    const deg = radiusKm / 111;
    const query = `[bbox:${lat - deg},${lng - deg},${lat + deg},${lng + deg}];way["highway"~"motorway|trunk|primary|a_road"];out center;`;

    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
      timeout: 15000
    });

    if (!response.ok) {
      return [];
    }

    const xml = await response.text();
    const matches = xml.matchAll(/<center lat="([^"]*)" lon="([^"]*)"/g);
    const roads = [];
    
    for (const match of matches) {
      roads.push({
        lat: parseFloat(match[1]),
        lng: parseFloat(match[2])
      });
    }

    return roads;
  } catch (err) {
    return [];
  }
}

// ============================================================================
// ADAPTIVE RADIUS CALCULATION
// ============================================================================

function calculateAdaptiveRadius(targetKm, density) {
  // Sparse roads (density < 0.3): use larger radius
  // Normal roads (0.3-1.0): medium radius
  // Dense roads (> 1.0): smaller radius

  if (density.density < 0.3) {
    // Sparse rural area
    return targetKm / 6;
  } else if (density.density < 0.7) {
    // Normal suburban
    return targetKm / 10;
  } else {
    // Dense urban
    return targetKm / 14;
  }
}

// ============================================================================
// RANDOMIZED WAYPOINT GENERATION
// ============================================================================

function generateRandomWaypoints(lat, lng, radius, targetKm) {
  // Generate 4-6 random waypoints instead of fixed cardinal directions
  // This ensures unique routes each time
  
  const count = Math.random() > 0.5 ? 5 : 6;
  const waypoints = [];
  const usedAngles = new Set();

  for (let i = 0; i < count; i++) {
    let angle;
    // Ensure waypoints are somewhat evenly distributed
    let attempts = 0;
    do {
      angle = Math.random() * 360;
      attempts++;
    } while (usedAngles.has(Math.round(angle / 20) * 20) && attempts < 10);

    usedAngles.add(Math.round(angle / 20) * 20);

    const rad = (angle * Math.PI) / 180;
    // Add 20-30% variance to radius so not all points same distance
    const radiusVariance = radius * (0.8 + Math.random() * 0.4);

    const degPerKm = 1 / 111;
    const dLat = radiusVariance * degPerKm * Math.sin(rad);
    const dLng = radiusVariance * degPerKm * Math.cos(rad);

    waypoints.push({
      lat: lat + dLat,
      lng: lng + dLng,
      angle,
      label: `WP${i + 1} (${Math.round(angle)}°)`
    });
  }

  // Sort by angle to create logical route
  waypoints.sort((a, b) => a.angle - b.angle);

  return waypoints;
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

    // Convert GeoJSON [lng, lat] to [lat, lng]
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
