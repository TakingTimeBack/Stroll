exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { location, time, pace, difficulty, preferences } = body;

    // Step 1: Geocode location
    const geoResponse = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`
    );
    const geoData = await geoResponse.json();
    
    if (!geoData || geoData.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Location not found' })
      };
    }

    const centerLat = parseFloat(geoData[0].lat);
    const centerLng = parseFloat(geoData[0].lon);

    // Step 2: Calculate route distance and create waypoints
    const distanceKm = (time / 60) * pace;
    
    // Adjust radius based on distance
    let radius = 0.01; // Default ~1km
    if (distanceKm > 5) radius = 0.025;
    if (distanceKm > 10) radius = 0.04;
    if (distanceKm > 15) radius = 0.06;

    // Create circular waypoints
    const numWaypoints = Math.max(8, Math.ceil(distanceKm / 2));
    const waypoints = [];

    for (let i = 0; i < numWaypoints; i++) {
      const angle = (i / numWaypoints) * Math.PI * 2;
      const variation = 1 + (Math.random() - 0.5) * 0.2;
      const lat = centerLat + radius * Math.sin(angle) * variation;
      const lng = centerLng + radius * Math.cos(angle) * variation;
      waypoints.push([lng, lat]); // OSRM wants [lng, lat]
    }

    // Close the loop
    waypoints.push(waypoints[0]);

    // Step 3: Route using OSRM
    const waypointString = waypoints.map(p => `${p[0]},${p[1]}`).join(';');
    const routeUrl = `https://router.project-osrm.org/route/v1/foot/${waypointString}?steps=false&geometries=geojson`;

    const routeResponse = await fetch(routeUrl);
    const routeData = await routeResponse.json();

    if (routeData.code !== 'Ok' || !routeData.routes || routeData.routes.length === 0) {
      // Fallback to simple circular route if OSRM fails
      return generateFallbackRoute(centerLat, centerLng, distanceKm, difficulty);
    }

    const route = routeData.routes[0];
    const coordinates = route.geometry.coordinates.map(c => [c[1], c[0]]); // Convert back to [lat, lng]
    const actualDistance = (route.distance / 1000).toFixed(1);
    const elevationGain = difficulty === 'easy' ? 50 : difficulty === 'moderate' ? 150 : 250;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        coordinates: coordinates,
        distance: parseFloat(actualDistance),
        elevation: elevationGain,
        duration: time,
        location: location,
        success: true
      })
    };
  } catch (error) {
    console.error('Error:', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Route generation failed', message: error.message })
    };
  }
};

// Fallback if OSRM fails
function generateFallbackRoute(centerLat, centerLng, distanceKm, difficulty) {
  let radius = 0.01;
  if (distanceKm > 5) radius = 0.025;
  if (distanceKm > 10) radius = 0.04;

  const numWaypoints = Math.max(8, Math.ceil(distanceKm / 2));
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
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({
      coordinates: coordinates,
      distance: parseFloat(distanceKm.toFixed(1)),
      elevation: elevationGain,
      duration: 0,
      success: true
    })
  };
}
