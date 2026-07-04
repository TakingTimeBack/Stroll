exports.handler = async (event) => {
  const LOG = [];
  LOG.push("=== STROLL OSRM ROUTER ===");
  
  try {
    const body = JSON.parse(event.body);
    const { location, time, pace } = body;
    LOG.push(`INPUT: ${location}, ${time}min, ${pace}km/h`);

    if (!location || time === undefined || !pace) {
      return respond(400, { error: "Missing params", debug: LOG });
    }

    // Geocode
    const coords = await geocode(location);
    if (!coords) {
      LOG.push("FAIL: Geocode");
      return respond(400, { error: "Could not geocode", debug: LOG });
    }
    const [lat, lng] = coords;
    LOG.push(`OK: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);

    const targetKm = (time / 60) * pace;
    LOG.push(`TARGET: ${targetKm.toFixed(2)}km`);

    // Waypoints
    LOG.push("STEP: Generate waypoints");
    const radius = Math.min(0.4, targetKm / 8);
    const waypoints = [];
    for (let i = 0; i < 4; i++) {
      const angle = (i * 90 + Math.random() * 30) * Math.PI / 180;
      const r = radius * (0.8 + Math.random() * 0.4) / 111;
      waypoints.push({
        lat: lat + r * Math.sin(angle),
        lng: lng + r * Math.cos(angle)
      });
    }
    LOG.push(`WAYPOINTS: ${waypoints.length}`);

    // Route
    LOG.push("STEP: Route via OSRM");
    let allCoords = [];
    let lastPt = { lat, lng };

    for (let i = 0; i < waypoints.length; i++) {
      const segment = await routeOSRM(lastPt, waypoints[i]);
      if (segment && segment.length > 0) {
        if (allCoords.length === 0) {
          allCoords.push(...segment);
        } else {
          allCoords.push(...segment.slice(1));
        }
        lastPt = waypoints[i];
        LOG.push(`  Segment ${i + 1}: ${segment.length} points`);
      }
    }

    // Return to start
    const returnSeg = await routeOSRM(lastPt, { lat, lng });
    if (returnSeg && returnSeg.length > 0) {
      allCoords.push(...returnSeg.slice(1));
      LOG.push(`  Return: ${returnSeg.length} points`);
    }

    if (allCoords.length < 2) {
      LOG.push("FAIL: No routes");
      const fallback = circle(lat, lng, targetKm);
      return respond(200, {
        coordinates: fallback,
        distance: targetKm,
        elevation: 50 + Math.round(targetKm / 2),
        success: true,
        pattern: "fallback",
        debug: LOG
      });
    }

    // Distance
    let totalDist = 0;
    for (let i = 0; i < allCoords.length - 1; i++) {
      totalDist += haversine(allCoords[i][0], allCoords[i][1], 
                             allCoords[i + 1][0], allCoords[i + 1][1]);
    }

    LOG.push(`SUCCESS: ${allCoords.length} points, ${totalDist.toFixed(2)}km`);

    return respond(200, {
      coordinates: allCoords,
      distance: parseFloat(totalDist.toFixed(2)),
      elevation: 50 + Math.round(totalDist / 2),
      success: true,
      debug: LOG
    });

  } catch (err) {
    LOG.push(`ERROR: ${err.message}`);
    return respond(500, { error: err.message, debug: LOG });
  }
};

function respond(status, data) {
  return {
    statusCode: status,
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(data)
  };
}

async function geocode(location) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
    const res = await fetch(url, { headers: { "User-Agent": "Stroll" } });
    const data = await res.json();
    if (data && data[0]) {
      return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
    }
  } catch (e) {}
  return null;
}

async function routeOSRM(from, to) {
  try {
    const url = `https://router.project-osrm.org/route/v1/foot/${from.lng},${from.lat};${to.lng},${to.lat}?geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.routes && data.routes[0]) {
      const coords = data.routes[0].geometry.coordinates;
      return coords.map(c => [c[1], c[0]]);
    }
  } catch (e) {}
  return null;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.asin(Math.sqrt(a));
}

function circle(lat, lng, km) {
  const coords = [];
  const radius = km / (Math.PI * 2) / 111;
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    coords.push([
      lat + radius * Math.sin(a),
      lng + radius * Math.cos(a)
    ]);
  }
  return coords;
}
