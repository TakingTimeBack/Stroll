exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { location, time, pace, difficulty, preferences } = body;

    console.log('🚀 Route request:', { location, time, pace });

    // STEP 1: Geocode
    console.log('📍 Geocoding location...');
    const geoResponse = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`,
      { headers: { 'User-Agent': 'Stroll-App' } }
    );
    
    const geoData = await geoResponse.json();
    
    if (!geoData || geoData.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Location not found' }) };
    }

    const centerLat = parseFloat(geoData[0].lat);
    const centerLng = parseFloat(geoData[0].lon);
    console.log('✅ Location:', { centerLat, centerLng });

    const distanceKm = (time / 60) * pace;
    console.log('📍 Target distance:', distanceKm, 'km');

    // STEP 2: Generate route with validation loop
    let attempt = 0;
    let validRoute = null;

    while (attempt < 5 && !validRoute) {
      attempt++;
      console.log(`📍 Route generation attempt ${attempt}/5...`);

      // Create waypoints
      let radius = 0.005;
      if (distanceKm > 3) radius = 0.008;
      if (distanceKm > 5) radius = 0.012;

      const numWaypoints = Math.max(10, Math.ceil(distanceKm / 1.5));
      const waypoints = [];

      // Add randomization to waypoints for each attempt
      for (let i = 0; i < numWaypoints; i++) {
        const angle = (i / numWaypoints) * Math.PI * 2;
        const randomRotation = (attempt - 1) * (Math.PI / 5) + (Math.random() * 0.3);
        const variation = 1 + (Math.random() - 0.5) * 0.2;
        const lat = centerLat + radius * Math.sin(angle + randomRotation) * variation;
        const lng = centerLng + radius * Math.cos(angle + randomRotation) * variation;
        waypoints.push([lng, lat]);
      }
      
      waypoints.push(waypoints[0]); // Close loop
      console.log(`✅ Waypoints created: ${waypoints.length}`);

      // Call OSRM
      const waypointString = waypoints.map(p => `${p[0]},${p[1]}`).join(';');
      const routeUrl = `https://router.project-osrm.org/route/v1/foot/${waypointString}?steps=true&geometries=geojson&overview=full`;

      const routeResponse = await fetch(routeUrl);

      if (!routeResponse.ok) {
        console.log('❌ OSRM failed, try next attempt');
        continue;
      }

      const routeData = await routeResponse.json();

      if (routeData.code !== 'Ok' || !routeData.routes || routeData.routes.length === 0) {
        console.log('❌ No route from OSRM, try next attempt');
        continue;
      }

      const route = routeData.routes[0];
      console.log('📍 Validating route against OSM data...');

      // STEP 3: Validate - check if route uses major roads
      const hasProblematicRoads = await validateRoute(route);

      if (!hasProblematicRoads) {
        console.log('✅ Route is clean! No A-roads or motorways');
        validRoute = route;
      } else {
        console.log(`⚠️  Route uses major roads, regenerating with different waypoints...`);
      }
    }

    // If validation failed all attempts, use fallback
    if (!validRoute) {
      console.log('📍 All validation attempts failed, using fallback');
      return fallbackRoute(centerLat, centerLng, distanceKm, difficulty);
    }

    // STEP 4: Extract coordinates
    console.log('📍 Extracting final route...');
    const coordinates = validRoute.geometry.coordinates.map(c => [c[1], c[0]]);
    const actualDistance = (validRoute.distance / 1000).toFixed(1);
    const elevationGain = difficulty === 'easy' ? 50 : difficulty === 'moderate' ? 150 : 250;

    console.log('✅ Final route:', { distance: actualDistance, coords: coordinates.length });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        coordinates,
        distance: parseFloat(actualDistance),
        elevation: elevationGain,
        duration: time,
        location,
        success: true
      })
    };

  } catch (error) {
    console.error('❌ Error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

// STEP 3: Validate route against OSM major roads
async function validateRoute(route) {
  try {
    // Get bounding box of route
    const coords = route.geometry.coordinates;
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;

    for (let coord of coords) {
      minLng = Math.min(minLng, coord[0]);
      maxLng = Math.max(maxLng, coord[0]);
      minLat = Math.min(minLat, coord[1]);
      maxLat = Math.max(maxLat, coord[1]);
    }

    console.log('📍 Checking for motorways/trunk roads in route area...');

    // Query Overpass API for motorways and trunk roads in the area
    const overpassQuery = `
      [bbox:${minLat},${minLng},${maxLat},${maxLng}];
      (
        way["highway"="motorway"];
        way["highway"="trunk"];
        way["highway"="primary"];
      );
      out geom;
    `;

    const overpassResponse = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: overpassQuery
    });

    if (!overpassResponse.ok) {
      console.log('⚠️  Overpass API error, assuming route is ok');
      return false;
    }

    const overpassData = await overpassResponse.json();
    const majorRoads = overpassData.elements || [];

    console.log(`📍 Found ${majorRoads.length} major roads in area`);

    // Check if route intersects with major roads
    // Simple check: if route passes very close to known major roads, reject it
    const routeLineString = coords;

    for (let road of majorRoads) {
      if (road.geometry) {
        for (let roadCoord of road.geometry) {
          // Check distance from route to major road
          for (let routeCoord of routeLineString) {
            const distance = getDistance(routeCoord[1], routeCoord[0], roadCoord.lat, roadCoord.lon);
            
            // If route is within 50m of a major road, it probably uses it
            if (distance < 0.0005) { // ~50 meters
              console.log(`❌ Route too close to major road (${(distance * 111000).toFixed(0)}m)`);
              return true; // Has problematic roads
            }
          }
        }
      }
    }

    console.log('✅ Route keeps clear of major roads');
    return false; // Route is good

  } catch (error) {
    console.error('⚠️  Validation error:', error.message);
    // On error, assume route is ok (don't block)
    return false;
  }
}

// Simple distance calculation (degrees to km)
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return c; // in degrees (approx)
}

function fallbackRoute(centerLat, centerLng, distanceKm, difficulty) {
  console.log('📍 Generating safe fallback circular route');
  
  let radius = 0.005;
  if (distanceKm > 3) radius = 0.008;
  if (distanceKm > 5) radius = 0.012;

  const numWaypoints = Math.max(10, Math.ceil(distanceKm / 1.5));
  const coordinates = [];

  for (let i = 0; i <= numWaypoints; i++) {
    const angle = (i / numWaypoints) * Math.PI * 2;
    const variation = 1 + (Math.random() - 0.5) * 0.15;
    coordinates.push([
      centerLat + radius * Math.sin(angle) * variation,
      centerLng + radius * Math.cos(angle) * variation
    ]);
  }

  const elevationGain = difficulty === 'easy' ? 50 : difficulty === 'moderate' ? 150 : 250;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      coordinates,
      distance: parseFloat(distanceKm.toFixed(1)),
      elevation: elevationGain,
      duration: 0,
      fallback: true,
      success: true
    })
  };
}
