exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { location, time, pace, difficulty, preferences } = body;

    console.log('Route request:', { location, time, pace, difficulty });

    // Step 1: Geocode location with error handling
    let geoResponse;
    try {
      geoResponse = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`,
        { headers: { 'User-Agent': 'Stroll-App' } }
      );
      
      if (!geoResponse.ok) {
        console.error('Nominatim error:', geoResponse.status);
        throw new Error(`Nominatim returned ${geoResponse.status}`);
      }

      const responseText = await geoResponse.text();
      console.log('Nominatim response:', responseText.substring(0, 100));
      
      let geoData;
      try {
        geoData = JSON.parse(responseText);
      } catch (e) {
        console.error('JSON parse error:', e);
        throw new Error('Invalid JSON from Nominatim: ' + responseText.substring(0, 50));
      }
      
      if (!geoData || geoData.length === 0) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Location not found' })
        };
      }

      const centerLat = parseFloat(geoData[0].lat);
      const centerLng = parseFloat(geoData[0].lon);
      console.log('Geocoded location:', { centerLat, centerLng });

      // Step 2: Calculate route distance and create waypoints
      const distanceKm = (time / 60) * pace;
      
      let radius = 0.01;
      if (distanceKm > 5) radius = 0.025;
      if (distanceKm > 10) radius = 0.04;
      if (distanceKm > 15) radius = 0.06;

      const numWaypoints = Math.max(8, Math.ceil(distanceKm / 2));
      const waypoints = [];

      for (let i = 0; i < numWaypoints; i++) {
        const angle = (i / numWaypoints) * Math.PI * 2;
        const variation = 1 + (Math.random() - 0.5) * 0.2;
        const lat = centerLat + radius * Math.sin(angle) * variation;
        const lng = centerLng + radius * Math.cos(angle) * variation;
        waypoints.push([lng, lat]);
      }

      waypoints.push(waypoints[0]);

      // Step 3: Route using OSRM with error handling
      const waypointString = waypoints.map(p => `${p[0]},${p[1]}`).join(';');
      const routeUrl = `https://router.project-osrm.org/route/v1/foot/${waypointString}?steps=false&geometries=geojson`;

      console.log('Calling OSRM...');
      const routeResponse = await fetch(routeUrl);

      if (!routeResponse.ok) {
        console.error('OSRM error:', routeResponse.status);
        throw new Error(`OSRM returned ${routeResponse.status}`);
      }

      const routeText = await routeResponse.text();
      console.log('OSRM response length:', routeText.length);

      let routeData;
      try {
        routeData = JSON.parse(routeText);
      } catch (e) {
        console.error('OSRM JSON parse error:', e);
        console.log('OSRM response:', routeText.substring(0, 200));
        throw new Error('Invalid JSON from OSRM');
      }

      if (routeData.code !== 'Ok' || !routeData.routes || routeData.routes.length === 0) {
        console.log('OSRM returned:', routeData.code);
        return generateFallbackRoute(centerLat, centerLng, distanceKm, difficulty);
      }

      const route = routeData.routes[0];
      const coordinates = route.geometry.coordinates.map(c => [c[1], c[0]]);
      const actualDistance = (route.distance / 1000).toFixed(1);
      const elevationGain = difficulty === 'easy' ? 50 : difficulty === 'moderate' ? 150 : 250;

      console.log('Route generated:', { actualDistance, elevationGain });

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
    } catch (apiError) {
      console.error('API Error:', apiError.message);
      console.log('Returning fallback route');
      return generateFallbackRoute(0, 0, time / 60 * pace, difficulty);
    }
  } catch (error) {
    console.error('Handler error:', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};

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
