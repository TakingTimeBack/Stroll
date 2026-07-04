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

    // STEP 3: Create waypoints
    console.log('📍 Creating waypoints...');
    
    let radius = 0.005;
    if (distanceKm > 3) radius = 0.008;
    if (distanceKm > 5) radius = 0.012;
    if (distanceKm > 8) radius = 0.015;

    const numWaypoints = Math.max(10, Math.ceil(distanceKm / 1.5));
    const waypoints = [];

    for (let i = 0; i < numWaypoints; i++) {
      const angle = (i / numWaypoints) * Math.PI * 2;
      const variation = 1 + (Math.random() - 0.5) * 0.15;
      const lat = centerLat + radius * Math.sin(angle) * variation;
      const lng = centerLng + radius * Math.cos(angle) * variation;
      waypoints.push({ point: { lat, lng } });
    }
    
    waypoints.push(waypoints[0]); // Close loop
    console.log('✅ Waypoints:', waypoints.length);

    // STEP 4: Call GraphHopper with avoid=motorway,trunk,primary
    // This REFUSES to use A-roads, motorways, dual carriageways
    console.log('📍 Routing with GraphHopper (avoiding motorways)...');
    
    // Build points string: lat,lng;lat,lng;...
    const pointsString = waypoints.map(w => `${w.point.lat},${w.point.lng}`).join(';');
    
    const graphhopperUrl = `https://graphhopper.com/api/1/route?` +
      `points=${encodeURIComponent(pointsString)}` +
      `&profile=foot` +
      `&avoid=motorway,trunk,primary` +
      `&locale=en` +
      `&points_encoded=false` +
      `&key=7ea3e26c-e487-4f9a-b52b-b86c5b5cc387`;

    console.log('📍 GraphHopper request sent');

    const routeResponse = await fetch(graphhopperUrl);

    if (!routeResponse.ok) {
      console.error('❌ GraphHopper error:', routeResponse.status);
      console.log('Using fallback route');
      return fallbackRoute(centerLat, centerLng, distanceKm, difficulty);
    }

    const routeData = await routeResponse.json();
    console.log('✅ GraphHopper response received');

    if (!routeData.paths || routeData.paths.length === 0) {
      console.log('❌ No paths returned, fallback');
      return fallbackRoute(centerLat, centerLng, distanceKm, difficulty);
    }

    // STEP 5: Extract coordinates
    console.log('📍 Extracting coordinates...');
    const path = routeData.paths[0];
    
    if (!path.points || !path.points.coordinates) {
      console.log('❌ No coordinates, fallback');
      return fallbackRoute(centerLat, centerLng, distanceKm, difficulty);
    }

    // GraphHopper returns [lat, lng]
    const coordinates = path.points.coordinates;
    
    const actualDistance = (path.distance / 1000).toFixed(1);
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
