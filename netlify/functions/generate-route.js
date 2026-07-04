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
    console.log('✅ Location found:', { centerLat, centerLng });

    // STEP 2: Calculate distance
    const distanceKm = (time / 60) * pace;
    console.log('📍 Distance target:', distanceKm, 'km');

    // STEP 3: Create DENSE waypoints with SMALL radius
    // KEY: Small radius + many waypoints = forces use of local roads, avoids highways
    console.log('📍 Creating dense waypoint grid...');
    
    let radius = 0.005; // SMALL - keeps route very local
    if (distanceKm > 3) radius = 0.008;
    if (distanceKm > 5) radius = 0.012;
    if (distanceKm > 8) radius = 0.015;

    // MANY waypoints = densely packed = can't use bypass
    const numWaypoints = Math.max(12, Math.ceil(distanceKm / 1.5));
    const waypoints = [];

    console.log('📍 Creating', numWaypoints, 'waypoints with radius', radius);

    for (let i = 0; i < numWaypoints; i++) {
      const angle = (i / numWaypoints) * Math.PI * 2;
      const variation = 1 + (Math.random() - 0.5) * 0.15;
      const lat = centerLat + radius * Math.sin(angle) * variation;
      const lng = centerLng + radius * Math.cos(angle) * variation;
      waypoints.push([lng, lat]);
    }
    
    // Close the loop
    waypoints.push(waypoints[0]);
    console.log('✅ Waypoints created:', waypoints.length);

    // STEP 4: Call OSRM with foot profile
    console.log('📍 Routing with OSRM foot profile...');
    
    const waypointString = waypoints.map(p => `${p[0]},${p[1]}`).join(';');
    const routeUrl = `https://router.project-osrm.org/route/v1/foot/${waypointString}?steps=false&geometries=geojson&overview=full`;

    console.log('📍 OSRM URL:', routeUrl.substring(0, 100) + '...');

    const routeResponse = await fetch(routeUrl);

    if (!routeResponse.ok) {
      console.error('❌ OSRM error:', routeResponse.status);
      return fallbackRoute(centerLat, centerLng, distanceKm, difficulty);
    }

    const routeText = await routeResponse.text();
    console.log('✅ OSRM response received:', routeText.length, 'bytes');

    let routeData;
    try {
      routeData = JSON.parse(routeText);
    } catch (e) {
      console.error('❌ Parse error:', e.message);
      return fallbackRoute(centerLat, centerLng, distanceKm, difficulty);
    }

    if (routeData.code !== 'Ok' || !routeData.routes || routeData.routes.length === 0) {
      console.log('❌ OSRM returned no routes, using fallback');
      return fallbackRoute(centerLat, centerLng, distanceKm, difficulty);
    }

    // STEP 5: Extract coordinates
    console.log('📍 Extracting route coordinates...');
    const route = routeData.routes[0];
    const coordinates = route.geometry.coordinates.map(c => [c[1], c[0]]);
    
    const actualDistance = (route.distance / 1000).toFixed(1);
    const elevationGain = difficulty === 'easy' ? 50 : difficulty === 'moderate' ? 150 : 250;

    console.log('✅ Route generated:', {
      distance: actualDistance,
      coordinates: coordinates.length,
      elevation: elevationGain
    });

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
    console.error('❌ Handler error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

function fallbackRoute(centerLat, centerLng, distanceKm, difficulty) {
  console.log('📍 Generating fallback circular route');
  
  let radius = 0.005;
  if (distanceKm > 3) radius = 0.008;
  if (distanceKm > 5) radius = 0.012;

  const numWaypoints = Math.max(12, Math.ceil(distanceKm / 1.5));
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
