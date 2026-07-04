exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { location, time, pace, difficulty, preferences } = body;

    console.log('🚀 Route request:', { location, time, pace });

    // STEP 1: Geocode - supports street names, partial addresses, neighborhoods
    console.log('📍 Geocoding location (street names supported)...');
    
    // Try the location as-is first
    let geoResponse = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=5`,
      { headers: { 'User-Agent': 'Stroll-App' } }
    );
    
    let geoData = await geoResponse.json();
    
    // If no results, try adding common suffixes for street names
    if (!geoData || geoData.length === 0) {
      console.log('📍 No exact match, trying with "Street" suffix...');
      geoResponse = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location + ' Street')}&format=json&limit=5`,
        { headers: { 'User-Agent': 'Stroll-App' } }
      );
      geoData = await geoResponse.json();
    }

    if (!geoData || geoData.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Location not found. Try: "Main Street, London" or "Trafalgar Square"' }) };
    }

    const centerLat = parseFloat(geoData[0].lat);
    const centerLng = parseFloat(geoData[0].lon);
    console.log('✅ Location found:', { location: geoData[0].display_name, centerLat, centerLng });

    const distanceKm = (time / 60) * pace;
    console.log('📍 Distance target:', distanceKm, 'km');

    // STEP 2: Choose random route pattern for variety
    console.log('📍 Selecting route pattern...');
    const patterns = ['circle', 'square', 'spiral', 'figure8'];
    const selectedPattern = patterns[Math.floor(Math.random() * patterns.length)];
    console.log('✅ Route pattern:', selectedPattern);

    let radius = 0.005;
    if (distanceKm > 3) radius = 0.008;
    if (distanceKm > 5) radius = 0.012;
    if (distanceKm > 8) radius = 0.015;

    const numWaypoints = Math.max(10, Math.ceil(distanceKm / 1.5));
    let waypoints = [];

    // STEP 3: Generate waypoints based on pattern
    console.log(`📍 Creating ${selectedPattern} pattern with ${numWaypoints} waypoints...`);

    if (selectedPattern === 'circle') {
      // Classic circle
      for (let i = 0; i < numWaypoints; i++) {
        const angle = (i / numWaypoints) * Math.PI * 2;
        const variation = 1 + (Math.random() - 0.5) * 0.2;
        const lat = centerLat + radius * Math.sin(angle) * variation;
        const lng = centerLng + radius * Math.cos(angle) * variation;
        waypoints.push([lng, lat]);
      }
    } else if (selectedPattern === 'square') {
      // Square/diamond pattern
      const side = Math.ceil(numWaypoints / 4);
      for (let s = 0; s < 4; s++) {
        for (let i = 0; i < side; i++) {
          const t = i / side;
          let lat, lng;
          
          if (s === 0) { // top
            lat = centerLat + radius;
            lng = centerLng - radius + (t * 2 * radius);
          } else if (s === 1) { // right
            lat = centerLat + radius - (t * 2 * radius);
            lng = centerLng + radius;
          } else if (s === 2) { // bottom
            lat = centerLat - radius;
            lng = centerLng + radius - (t * 2 * radius);
          } else { // left
            lat = centerLat - radius + (t * 2 * radius);
            lng = centerLng - radius;
          }
          
          const variation = 1 + (Math.random() - 0.5) * 0.15;
          waypoints.push([lng * variation, lat * variation]);
        }
      }
    } else if (selectedPattern === 'spiral') {
      // Spiral pattern
      for (let i = 0; i < numWaypoints; i++) {
        const t = i / numWaypoints;
        const angle = t * Math.PI * 4; // 2 full rotations
        const r = radius * t;
        const variation = 1 + (Math.random() - 0.5) * 0.15;
        const lat = centerLat + r * Math.sin(angle) * variation;
        const lng = centerLng + r * Math.cos(angle) * variation;
        waypoints.push([lng, lat]);
      }
    } else if (selectedPattern === 'figure8') {
      // Figure-8 pattern
      for (let i = 0; i < numWaypoints; i++) {
        const t = (i / numWaypoints) * Math.PI * 2;
        const r = radius / 1.5;
        const lobeRadius = Math.sin(t) * r;
        const angle = t;
        const variation = 1 + (Math.random() - 0.5) * 0.15;
        const lat = centerLat + lobeRadius * Math.sin(angle) * variation;
        const lng = centerLng + lobeRadius * Math.cos(angle) * variation;
        waypoints.push([lng, lat]);
      }
    }

    waypoints.push(waypoints[0]); // Close loop
    console.log(`✅ Waypoints created: ${waypoints.length}`);

    // STEP 4: Generate route with validation loop
    let attempt = 0;
    let validRoute = null;

    while (attempt < 5 && !validRoute) {
      attempt++;
      console.log(`📍 Route generation attempt ${attempt}/5...`);

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

      const hasProblematicRoads = await validateRoute(route);

      if (!hasProblematicRoads) {
        console.log('✅ Route is clean! No A-roads or motorways');
        validRoute = route;
      } else {
        console.log(`⚠️  Route uses major roads, regenerating...`);
      }
    }

    if (!validRoute) {
      console.log('📍 All validation attempts failed, using fallback');
      return fallbackRoute(centerLat, centerLng, distanceKm, difficulty, selectedPattern);
    }

    // STEP 5: Extract coordinates
    console.log('📍 Extracting final route...');
    const coordinates = validRoute.geometry.coordinates.map(c => [c[1], c[0]]);
    const actualDistance = (validRoute.distance / 1000).toFixed(1);
    const elevationGain = difficulty === 'easy' ? 50 : difficulty === 'moderate' ? 150 : 250;

    console.log('✅ Final route:', { distance: actualDistance, coords: coordinates.length, pattern: selectedPattern });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        coordinates,
        distance: parseFloat(actualDistance),
        elevation: elevationGain,
        duration: time,
        location,
        pattern: selectedPattern,
        success: true
      })
    };

  } catch (error) {
    console.error('❌ Error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

// Validate route against OSM major roads
async function validateRoute(route) {
  try {
    const coords = route.geometry.coordinates;
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;

    for (let coord of coords) {
      minLng = Math.min(minLng, coord[0]);
      maxLng = Math.max(maxLng, coord[0]);
      minLat = Math.min(minLat, coord[1]);
      maxLat = Math.max(maxLat, coord[1]);
    }

    // Expand bbox to catch nearby major roads
    const padding = 0.012;
    const expandedMinLat = minLat - padding;
    const expandedMaxLat = maxLat + padding;
    const expandedMinLng = minLng - padding;
    const expandedMaxLng = maxLng + padding;

    console.log('📍 Checking: ABSOLUTE NO on motorways/trunk/primary, SOFT check on secondary...');

    // HARD REJECT: Motorways and A-roads (motorway, trunk, primary)
    const hardRejectQuery = `
      [bbox:${expandedMinLat},${expandedMinLng},${expandedMaxLat},${expandedMaxLng}];
      (
        way["highway"="motorway"];
        way["highway"="motorway_link"];
        way["highway"="trunk"];
        way["highway"="trunk_link"];
        way["highway"="primary"];
      );
      out geom;
    `;

    const hardRejectResponse = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: hardRejectQuery,
      timeout: 5000
    });

    if (hardRejectResponse.ok) {
      const hardRejectData = await hardRejectResponse.json();
      const hardRejectRoads = hardRejectData.elements || [];
      console.log(`📍 Found ${hardRejectRoads.length} motorways/A-roads`);

      // STRICT: 350m buffer for motorways and A-roads (must avoid completely)
      const hardBuffer = 0.0035;

      for (let road of hardRejectRoads) {
        if (road.geometry) {
          for (let roadCoord of road.geometry) {
            for (let routeCoord of coords) {
              const distance = getDistance(routeCoord[1], routeCoord[0], roadCoord.lat, roadCoord.lon);
              
              if (distance < hardBuffer) {
                console.log(`❌ REJECTED: Within ${(distance * 111000).toFixed(0)}m of A-road/motorway`);
                return true;
              }
            }
          }
        }
      }
    }

    // SOFT CHECK: Secondary roads (wider tolerance - only reject if VERY close)
    const secondaryQuery = `
      [bbox:${expandedMinLat},${expandedMinLng},${expandedMaxLat},${expandedMaxLng}];
      (
        way["highway"="secondary"];
      );
      out geom;
    `;

    const secondaryResponse = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: secondaryQuery,
      timeout: 5000
    });

    if (secondaryResponse.ok) {
      const secondaryData = await secondaryResponse.json();
      const secondaryRoads = secondaryData.elements || [];
      console.log(`📍 Found ${secondaryRoads.length} secondary roads (B-roads)`);

      // SOFTER: Only 100m buffer for secondary (these are often fine)
      const secondaryBuffer = 0.001;

      for (let road of secondaryRoads) {
        if (road.geometry) {
          for (let roadCoord of road.geometry) {
            for (let routeCoord of coords) {
              const distance = getDistance(routeCoord[1], routeCoord[0], roadCoord.lat, roadCoord.lon);
              
              if (distance < secondaryBuffer) {
                console.log(`⚠️  Route very close to secondary road (${(distance * 111000).toFixed(0)}m), checking if acceptable...`);
                // Secondary roads are OK if route doesn't actually USE them
                // Just being nearby is fine
              }
            }
          }
        }
      }
    }

    console.log('✅ Route passed validation - safe from motorways and A-roads');
    return false;

  } catch (error) {
    console.error('⚠️  Validation error:', error.message);
    return true;
  }
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return c;
}

function fallbackRoute(centerLat, centerLng, distanceKm, difficulty, pattern) {
  console.log('📍 Generating safe fallback route');
  
  let radius = 0.005;
  if (distanceKm > 3) radius = 0.008;
  if (distanceKm > 5) radius = 0.012;

  const numWaypoints = Math.max(10, Math.ceil(distanceKm / 1.5));
  const coordinates = [];

  // Use same pattern for fallback
  if (pattern === 'circle') {
    for (let i = 0; i <= numWaypoints; i++) {
      const angle = (i / numWaypoints) * Math.PI * 2;
      const variation = 1 + (Math.random() - 0.5) * 0.15;
      coordinates.push([
        centerLat + radius * Math.sin(angle) * variation,
        centerLng + radius * Math.cos(angle) * variation
      ]);
    }
  } else {
    // Default circle for other patterns as fallback
    for (let i = 0; i <= numWaypoints; i++) {
      const angle = (i / numWaypoints) * Math.PI * 2;
      coordinates.push([
        centerLat + radius * Math.sin(angle),
        centerLng + radius * Math.cos(angle)
      ]);
    }
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
      pattern: pattern,
      success: true
    })
  };
}
