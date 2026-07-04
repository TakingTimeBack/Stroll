exports.handler = async (event) => {
  const LOG = [];
  LOG.push("=== STROLL OSRM ADAPTIVE ROUTER ===");
  
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

    // Adaptive routing with feedback
    let radius = Math.min(0.5, targetKm / 6);
    let actualDist = 0;
    let allCoords = [];
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      LOG.push(`ATTEMPT ${attempts}: radius=${radius.toFixed(3)}`);

      allCoords = [];
      actualDist = 0;

      // Generate waypoints at this radius
      const waypoints = [];
      for (let i = 0; i < 4; i++) {
        const angle = (i * 90 + (Math.random() - 0.5) * 20) * Math.PI / 180;
        const r = radius * (0.85 + Math.random() * 0.3) / 111;
        waypoints.push({
          lat: lat + r * Math.sin(angle),
          lng: lng + r * Math.cos(angle)
        });
      }

      // Route
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
        }
      }

      // Return to start
      const returnSeg = await routeOSRM(lastPt, { lat, lng });
      if (returnSeg && returnSeg.length > 0) {
        allCoords.push(...returnSeg.slice(1));
      }

      // Calculate distance
      if (allCoords.length >= 2) {
        actualDist = 0;
        for (let i = 0; i < allCoords.length - 1; i++) {
          actualDist += haversine(allCoords[i][0], allCoords[i][1], 
                                  allCoords[i + 1][0], allCoords[i + 1][1]);
        }
        LOG.push(`  Distance: ${actualDist.toFixed(2)}km (${((actualDist / targetKm) * 100).toFixed(0)}%)`);

        // Check if close enough (within 10%)
        if (actualDist >= targetKm * 0.9 && actualDist <= targetKm * 1.1) {
          LOG.push(`SUCCESS: Within 10% of target`);
          return respond(200, {
            coordinates: allCoords,
            distance: parseFloat(actualDist.toFixed(2)),
            elevation: 50 + Math.round(actualDist / 2),
            success: true,
            pattern: "osrm-adaptive",
            debug: LOG
          });
        }

        // Adjust radius for next attempt
        if (actualDist < targetKm * 0.8) {
          radius *= 1.3;
        } else if (actualDist > targetKm * 1.2) {
          radius *= 0.7;
        } else {
          radius *= (targetKm / actualDist);
        }
      } else {
        LOG.push(`  Failed to route`);
        radius *= 1.2;
      }
    }

    // After max attempts, use what we have
    if (allCoords.length >= 2) {
      LOG.push(`FINAL: ${actualDist.toFixed(2)}km after ${attempts} attempts`);
      return respond(200, {
        coordinates: allCoords,
        distance: parseFloat(actualDist.toFixed(2)),
        elevation: 50 + Math.round(actualDist / 2),
        success: true,
        pattern: "osrm-adaptive",
        debug: LOG
      });
    }

    // Fallback to circle
    LOG.push("FALLBACK: Circle");
    const fallback = circle(lat, lng, targetKm);
    return respond(200, {
      coordinates: fallback,
      distance: targetKm,
      elevation: 50 + Math.round(targetKm / 2),
      success: true,
      pattern: "fallback-circle",
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
