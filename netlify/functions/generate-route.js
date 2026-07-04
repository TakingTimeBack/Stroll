exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { location, time, pace, difficulty, preferences } = body;

    console.log('🚀 Route request:', { location, time, pace, difficulty });

    // ==================== STEP 1: GEOCODE LOCATION ====================
    console.log('📍 Step 1: Geocoding location...');
    let geoResponse;
    try {
      geoResponse = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`,
        { headers: { 'User-Agent': 'Stroll-App' } }
      );
      
      if (!geoResponse.ok) {
        throw new Error(`Nominatim returned ${geoResponse.status}`);
      }

      const responseText = await geoResponse.text();
      let geoData;
      
      try {
        geoData = JSON.parse(responseText);
      } catch (e) {
        throw new Error('Invalid JSON from Nominatim');
      }
      
      if (!geoData || geoData.length === 0) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Location not found' })
        };
      }

      const centerLat = parseFloat(geoData[0].lat);
      const centerLng = parseFloat(geoData[0].lon);
      console.log('✅ Location found:', { centerLat, centerLng });

      // ==================== STEP 2: CREATE CIRCULAR WAYPOINTS ====================
      console.log('📍 Step 2: Creating circular waypoints...');
      const distanceKm = (time / 60) * pace;
      
      let radius = 0.01;
      if (distanceKm > 5) radius = 0.025;
      if (distanceKm > 10) radius = 0.04;
      if (distanceKm > 15) radius = 0.06;

      const numWaypoints = Math.max(8, Math.ceil(distanceKm / 2));
      const waypoints = [];

      // Create circular waypoints around center
      for (let i = 0; i < numWaypoints; i++) {
        const angle = (i / numWaypoints) * Math.PI * 2;
        const variation = 1 + (Math.random() - 0.5) * 0.2;
        const lat = centerLat + radius * Math.sin(angle) * variation;
        const lng = centerLng + radius * Math.cos(angle) * variation;
        waypoints.push({ lat, lon: lng });
      }
      
      // Close the loop
      waypoints.push(waypoints[0]);
      console.log('✅ Waypoints created:', waypoints.length);

      // ==================== STEP 3: ROUTE WITH VALHALLA ====================
      console.log('📍 Step 3: Calling Valhalla pedestrian routing...');
      
      const valhallaRequest = {
        locations: waypoints,
        costing: 'pedestrian',
        format: 'geojson',
        options: {
          pedestrian: {
            avoid_areas: true
          }
        }
      };

      console.log('Sending to Valhalla:', JSON.stringify(valhallaRequest).substring(0, 100) + '...');

      const routeResponse = await fetch('https://valhalla.openstreetmap.de/route', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Stroll-App'
        },
        body: JSON.stringify(valhallaRequest)
      });

      if (!routeResponse.ok) {
        console.error('❌ Valhalla error:', routeResponse.status, routeResponse.statusText);
        throw new Error(`Valhalla returned ${routeResponse.status}`);
      }

      const routeText = await routeResponse.text();
      console.log('✅ Valhalla response received, size:', routeText.length);

      let routeData;
      try {
        routeData = JSON.parse(routeText);
      } catch (e) {
        console.error('❌ JSON parse error:', e.message);
        console.log('Response preview:', routeText.substring(0, 200));
        throw new Error('Invalid JSON from Valhalla');
      }

      // Check if Valhalla returned valid route
      if (!routeData.features || routeData.features.length === 0) {
        console.log('❌ Valhalla returned no features, using fallback');
        return generateFallbackRoute(centerLat, centerLng, distanceKm, difficulty);
      }

      const route = routeData.features[0];
      
      if (!route.geometry || !route.geometry.coordinates) {
        console.log('❌ No geometry in response, using fallback');
        return generateFallbackRoute(centerLat, centerLng, distanceKm, difficulty);
      }

      // ==================== STEP 4: EXTRACT COORDINATES ====================
      console.log('📍 Step 4: Extracting coordinates...');
      
      // Valhalla returns [lon, lat], we need [lat, lon]
      const coordinates = route.geometry.coordinates.map(c => [c[1], c[0]]);
      
      // Extract distance from Valhalla response
      let actualDistance = distanceKm;
      if (route.properties && route.properties.segments && route.properties.segments[0]) {
        actualDistance = (route.properties.segments[0].distance / 1000).toFixed(1);
        console.log('✅ Distance from Valhalla:', actualDistance, 'km');
      } else {
        console.log('⚠️  Using estimated distance:', actualDistance, 'km');
      }

      const elevationGain = difficulty === 'easy' ? 50 : difficulty === 'moderate' ? 150 : 250;

      console.log('✅ Route generated successfully');
      console.log('Route stats:', { 
        actualDistance, 
        elevationGain, 
        numCoordinates: coordinates.length 
      });

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
      console.error('❌ API Error:', apiError.message);
      console.log('Returning fallback route...');
      return generateFallbackRoute(centerLat, centerLng, (time / 60) * pace, difficulty);
    }

  } catch (error) {
    console.error('❌ Handler error:', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};

// ==================== FALLBACK ROUTE ====================
function generateFallbackRoute(centerLat, centerLng, distanceKm, difficulty) {
  console.log('📍 Generating fallback circular route...');
  
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
      fallback: true,
      success: true
    })
  };
}
