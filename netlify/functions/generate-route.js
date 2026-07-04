exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { location, time, pace, difficulty, preferences } = body;

    console.log('🚀 Route request:', { location, time, pace });

    // STEP 1: Geocode
    console.log('📍 Geocoding...');
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
    console.log('✅ Found:', centerLat, centerLng);

    // STEP 2: Create waypoints
    console.log('📍 Creating waypoints...');
    const distanceKm = (time / 60) * pace;
    
    let radius = 0.01;
    if (distanceKm > 5) radius = 0.025;
    if (distanceKm > 10) radius = 0.04;

    const numWaypoints = Math.max(6, Math.ceil(distanceKm / 2));
    const waypoints = [];

    for (let i = 0; i < numWaypoints; i++) {
      const angle = (i / numWaypoints) * Math.PI * 2;
      const variation = 1 + (Math.random() - 0.5) * 0.2;
      waypoints.push({
        lat: centerLat + radius * Math.sin(angle) * variation,
        lon: centerLng + radius * Math.cos(angle) * variation
      });
    }
    waypoints.push(waypoints[0]); // Close loop
    console.log('✅ Waypoints:', waypoints.length);

    // STEP 3: Call Valhalla - SIMPLE FORMAT
    console.log('📍 Calling Valhalla...');
    
    const valhallaBody = {
      locations: waypoints,
      costing: 'pedestrian'
    };

    const routeResponse = await fetch('https://valhalla.openstreetmap.de/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valhallaBody)
    });

    console.log('📍 Valhalla status:', routeResponse.status);

    if (!routeResponse.ok) {
      console.error('❌ Valhalla error:', routeResponse.status);
      throw new Error('Valhalla failed');
    }

    const routeData = await routeResponse.json();
    console.log('✅ Response received');

    if (!routeData.features || routeData.features.length === 0) {
      console.log('❌ No features, fallback');
      return fallbackRoute(centerLat, centerLng, distanceKm, difficulty);
    }

    // STEP 4: Extract coordinates
    console.log('📍 Extracting coordinates...');
    const route = routeData.features[0];
    const coordinates = route.geometry.coordinates.map(c => [c[1], c[0]]);
    
    let actualDistance = distanceKm;
    if (route.properties && route.properties.segments) {
      actualDistance = (route.properties.segments[0].distance / 1000).toFixed(1);
    }

    const elevationGain = difficulty === 'easy' ? 50 : difficulty === 'moderate' ? 150 : 250;

    console.log('✅ Route ready:', { distance: actualDistance, coords: coordinates.length });

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

function fallbackRoute(centerLat, centerLng, distanceKm, difficulty) {
  let radius = 0.01;
  if (distanceKm > 5) radius = 0.025;
  if (distanceKm > 10) radius = 0.04;

  const numWaypoints = Math.max(6, Math.ceil(distanceKm / 2));
  const coordinates = [];

  for (let i = 0; i <= numWaypoints; i++) {
    const angle = (i / numWaypoints) * Math.PI * 2;
    const variation = 1 + (Math.random() - 0.5) * 0.2;
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
