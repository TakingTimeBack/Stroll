exports.handler = async (event) => {
  const LOG = [];
  try {
    LOG.push("=== STROLL OSRM ROUTER ===");
    const body = JSON.parse(event.body);
    const { location, time, pace } = body;
    LOG.push(`INPUT: ${location}, ${time}min, ${pace}km/h`);
    
    const [lat, lng] = await geocode(location) || [];
    if (!lat) return { statusCode: 400, body: JSON.stringify({ error: "Geocode failed", debug: LOG }) };
    LOG.push(`OK: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    
    const targetKm = (time / 60) * pace;
    const waypoints = randomWaypoints(lat, lng, Math.min(0.4, targetKm/8), 4);
    
    let coords = [];
    let lastPt = { lat, lng };
    
    for (const wp of waypoints) {
      const seg = await osrmRoute(lastPt, wp);
      if (seg && seg.length > 0) {
        coords.push(...(coords.length ? seg.slice(1) : seg));
        lastPt = wp;
        LOG.push(`Segment: ${seg.length} points`);
      }
    }
    
    const final = await osrmRoute(lastPt, { lat, lng });
    if (final && final.length > 0) coords.push(...final.slice(1));
    
    let dist = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      dist += haversine(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
    }
    
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ coordinates: coords, distance: dist.toFixed(2), elevation: 50 + Math.round(dist/2), success: true, debug: LOG })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message, debug: LOG }) };
  }
};

async function geocode(loc) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(loc)}&format=json&limit=1`);
  const d = await r.json();
  return d.length ? [parseFloat(d[0].lat), parseFloat(d[0].lon)] : null;
}

async function osrmRoute(from, to) {
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/foot/${from.lng},${from.lat};${to.lng},${to.lat}?geometries=geojson`);
    const d = await r.json();
    return d.routes && d.routes.length ? d.routes[0].geometry.coordinates.map(([l, t]) => [t, l]) : null;
  } catch (e) { return null; }
}

function randomWaypoints(lat, lng, r, n) {
  const w = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 360;
    const rad = (a * Math.PI) / 180;
    const rv = r * (0.7 + Math.random() * 0.6) / 111;
    w.push({ lat: lat + rv * Math.sin(rad), lng: lng + rv * Math.cos(rad) });
  }
  return w;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
