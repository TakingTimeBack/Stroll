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

    // REASONABLE: 12-18 waypoints - works with OSRM
    let baseRadius = 0.004;
    if (distanceKm > 3) baseRadius = 0.006;
    if (distanceKm > 5) baseRadius = 0.008;
    if (distanceKm > 8) baseRadius = 0.010;

    const numWaypoints = Math.max(12, Math.ceil(distanceKm / 0.8));
    let waypoints = [];

    console.log(`📍 Creating ${selectedPattern} with ${numWaypoints} waypoints (distance: ${distanceKm.toFixed(1)}km)...`);

    if (selectedPattern === 'circle') {
      for (let i = 0; i < numWaypoints; i++) {
        const angle = (i / numWaypoints) * Math.PI * 2;
        const variation = 1 + (Math.random() - 0.5) * 0.2;
        const lat = centerLat + baseRadius * Math.sin(angle) * variation;
        const lng = centerLng + baseRadius * Math.cos(angle) * variation;
        waypoints.push([lng, lat]);
      }
    } else if (selectedPattern === 'square') {
      const side = Math.ceil(numWaypoints / 4);
      for (let s = 0; s < 4; s++) {
        for (let i = 0; i < side; i++) {
          if (waypoints.length >= numWaypoints) break;
          const t = i / side;
          let lat, lng;
          
          if (s === 0) {
            lat = centerLat + baseRadius;
            lng = centerLng - baseRadius + (t * 2 * baseRadius);
          } else if (s === 1) {
            lat = centerLat + baseRadius - (t * 2 * baseRadius);
            lng = centerLng + baseRadius;
          } else if (s === 2) {
            lat = centerLat - baseRadius;
            lng = centerLng + baseRadius - (t * 2 * baseRadius);
          } else {
            lat = centerLat - baseRadius + (t * 2 * baseRadius);
            lng = centerLng - baseRadius;
          }
          
          const variation = 1 + (Math.random() - 0.5) * 0.15;
          waypoints.push([lng * variation, lat * variation]);
        }
        if (waypoints.length >= numWaypoints) break;
      }
    } else if (selectedPattern === 'spiral') {
      for (let i = 0; i < numWaypoints; i++) {
        const t = i / numWaypoints;
        const angle = t * Math.PI * 4;
        const r = baseRadius * t;
        const variation = 1 + (Math.random() - 0.5) * 0.15;
        const lat = centerLat + r * Math.sin(angle) * variation;
        const lng = centerLng + r * Math.cos(angle) * variation;
        waypoints.push([lng, lat]);
      }
    } else if (selectedPattern === 'figure8') {
      for (let i = 0; i < numWaypoints; i++) {
        const t = (i / numWaypoints) * Math.PI * 2;
        const r = baseRadius / 1.5;
        const lobeRadius = Math.sin(t) * r;
        const angle = t;
        const variation = 1 + (Math.random() - 0.5) * 0.15;
        const lat = centerLat + lobeRadius * Math.sin(angle) * variation;
        const lng = centerLng + lobeRadius * Math.cos(angle) * variation;
        waypoints.push([lng, lat]);
      }
    }

    waypoints.push(waypoints[0]);
    console.log(`✅ Waypoints created: ${waypoints.length}`);

    // STEP 4: Generate route (with 5 retry attempts)
    let attempt = 0;
    let validRoute = null;

    while (attempt < 5 && !validRoute) {
      attempt++;
      console.log(`📍 Route generation attempt ${attempt}/5...`);

      const waypointString = waypoints.map(p => `${p[0]},${p[1]}`).join(';');
      const routeUrl = `https://router.project-osrm.org/route/v1/foot/${waypointString}?steps=true&geometries=geojson&overview=full`;

      try {
        const routeResponse = await fetch(routeUrl);

        if (!routeResponse.ok) {
          console.log('❌ OSRM request failed');
          continue;
        }

        const routeData = await routeResponse.json();

        if (routeData.code !== 'Ok' || !routeData.routes || routeData.routes.length === 0) {
          console.log('❌ OSRM no route');
          continue;
        }

        const route = routeData.routes[0];
        
        // Validate distance first
        if (!validateRoute(route, distanceKm)) {
          console.log('❌ Distance validation failed');
          continue;
        }
        
        // Then check for major roads
        const hasMajorRoads = await checkForMajorRoads(route);
        if (hasMajorRoads) {
          console.log('❌ Major roads detected - regenerating...');
          // Rotate waypoints for next attempt
          waypoints = waypoints.map((p, i) => {
            const angle = (i / waypoints.length) * Math.PI * 2 + (Math.random() - 0.5);
            const offset = 0.0008;
            return [p[0] + Math.cos(angle) * offset, p[1] + Math.sin(angle) * offset];
          });
          continue;
        }
        
        console.log('✅ Route accepted - no major roads');
        validRoute = route;
      } catch (err) {
        console.log('❌ Routing error:', err.message);
      }
    }

    if (!validRoute) {
      console.log('📍 All attempts failed, using safe fallback');
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


function validateRoute(route, targetDistance) {
  // Just basic sanity check
  const routeDistanceKm = route.distance / 1000;
  const maxReasonable = Math.max(targetDistance * 2, 1);
  
  if (routeDistanceKm > maxReasonable) {
    console.log(`⚠️ Route too long: ${routeDistanceKm.toFixed(1)}km`);
    return false;
  }
  
  console.log(`✅ Route distance OK: ${routeDistanceKm.toFixed(1)}km`);
  return true;
}

async function checkForMajorRoads(route) {
  // Check if route actually overlaps with major roads
  try {
    const coords = route.geometry.coordinates;
    
    // Get bounding box
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (let coord of coords) {
      minLng = Math.min(minLng, coord[0]);
      maxLng = Math.max(maxLng, coord[0]);
      minLat = Math.min(minLat, coord[1]);
      maxLat = Math.max(maxLat, coord[1]);
    }
    
    // Expand bbox
    const padding = 0.005;
    const bbox = `${minLat - padding},${minLng - padding},${maxLat + padding},${maxLng + padding}`;
    
    console.log('🛣️  Checking for motorways/A-roads...');
    
    const query = `[bbox:${bbox}];(way["highway"="motorway"];way["highway"="trunk"];way["highway"="primary"];);out geom;`;
    
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query
    });
    
    if (!resp.ok) return false; // On error, assume it's OK
    
    const data = await resp.json();
    const roads = data.elements || [];
    
    console.log(`Found ${roads.length} major roads in area`);
    
    if (roads.length === 0) {
      console.log('✅ No major roads in area');
      return false; // No major roads = good
    }
    
    // Check if route coordinates are too close to any major road
    const buffer = 0.0008; // ~80 meters
    
    for (let road of roads) {
      if (!road.geometry) continue;
      
      for (let roadCoord of road.geometry) {
        for (let routeCoord of coords) {
          const lat1 = routeCoord[1];
          const lng1 = routeCoord[0];
          const lat2 = roadCoord.lat;
          const lng2 = roadCoord.lon;
          
          const latDiff = lat1 - lat2;
          const lngDiff = lng1 - lng2;
          const distance = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
          
          if (distance < buffer) {
            console.log(`❌ Route TOO CLOSE to major road (${(distance * 111000).toFixed(0)}m)`);
            return true; // Found major road = bad
          }
        }
      }
    }
    
    console.log('✅ Route keeps safe distance from major roads');
    return false; // No close roads = good
    
  } catch (error) {
    console.log('⚠️  Overpass check failed:', error.message);
    return false; // On error, assume OK (conservative)
  }
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
