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

    // VERY CONSERVATIVE RADIUS: Small and tight for all walk distances
    let baseRadius;
    
    if (distanceKm < 1.5) {
      baseRadius = 0.0006; // ~65m for very short walks (15-20 min)
    } else if (distanceKm < 2.5) {
      baseRadius = 0.0009; // ~100m for short walks (20-30 min)
    } else if (distanceKm < 3.5) {
      baseRadius = 0.0012; // ~130m for medium walks
    } else if (distanceKm < 5) {
      baseRadius = 0.0016; // ~180m (1h walk - 4km)
    } else if (distanceKm < 7) {
      baseRadius = 0.0022; // ~245m (1.5h walk - 6km)
    } else if (distanceKm < 10) {
      baseRadius = 0.0028; // ~310m (2h walk - 8km)
    } else {
      baseRadius = 0.0035; // ~390m for long walks
    }

    // STEP 3: Create natural circular walk with pattern variation
    console.log(`📍 Creating natural ${selectedPattern} walk...`);

    let waypoints = [];
    waypoints.push([centerLng, centerLat]); // Start at center

    // Pattern determines exploration
    let numExcursions;
    if (selectedPattern === 'circle') {
      numExcursions = 1; // Go in one direction
    } else if (selectedPattern === 'square') {
      numExcursions = 2; // Go in two opposite directions
    } else if (selectedPattern === 'spiral') {
      numExcursions = 1; // Single direction with slightly larger radius
    } else if (selectedPattern === 'figure8') {
      numExcursions = 2; // Two loops
    } else {
      numExcursions = 1;
    }

    // Create waypoints for exploration
    for (let e = 0; e < numExcursions; e++) {
      let angle = (e / Math.max(1, numExcursions - 1)) * Math.PI * 2;
      
      // Add randomness but not too much (no zigzags)
      angle += (Math.random() - 0.5) * 0.3;
      
      // Distance varies by pattern
      let distMultiplier = 0.9;
      if (selectedPattern === 'spiral') distMultiplier = 0.95; // Go further
      
      const distance = baseRadius * (0.7 + distMultiplier * 0.2);
      const lat = centerLat + distance * Math.sin(angle);
      const lng = centerLng + distance * Math.cos(angle);
      waypoints.push([lng, lat]);
    }

    waypoints.push([centerLng, centerLat]); // Return to center
    console.log(`✅ Created ${selectedPattern} walk (${waypoints.length} waypoints)`);


    console.log(`✅ Waypoints created: ${waypoints.length}`);

    // STEP 4: Route with OSRM foot profile
    console.log(`📍 Routing ${waypoints.length} waypoints with OSRM...`);

    const waypointString = waypoints.map(p => `${p[0]},${p[1]}`).join(';');
    const routeUrl = `https://router.project-osrm.org/route/v1/foot/${waypointString}?steps=true&geometries=geojson&overview=full`;

    let validRoute = null;

    try {
      const routeResponse = await fetch(routeUrl, { timeout: 10000 });

      if (routeResponse.ok) {
        const routeData = await routeResponse.json();

        if (routeData.code === 'Ok' && routeData.routes && routeData.routes.length > 0) {
          validRoute = routeData.routes[0];
          console.log(`✅ Route: ${(validRoute.distance / 1000).toFixed(1)}km`);
        }
      }
    } catch (err) {
      console.log('⚠️  Routing error:', err.message);
    }

    if (!validRoute) {
      console.log('📍 Routing failed, using safe fallback');
      return fallbackRoute(centerLat, centerLng, distanceKm, difficulty, selectedPattern);
    }

    // STEP 5: Extract coordinates
    console.log('📍 Extracting final route...');
    const coordinates = validRoute.geometry.coordinates.map(c => [c[1], c[0]]);
    const actualDistance = (validRoute.distance / 1000).toFixed(1);
    const elevationGain = Math.round(50 + (actualDistance / 2)); // Estimate based on distance

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

  
  const elevationGain = Math.round(50 + (distanceKm / 2)); // Estimate based on distance

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
