/**
 * STROLL INTELLIGENT PEDESTRIAN ROUTER - v2
 * Bulletproof error handling and logging
 */

exports.handler = async (event) => {
  try {
    console.log('🚶 START: Stroll Router');
    
    const body = JSON.parse(event.body);
    const { location, time, pace, preferences } = body;
    console.log(`📍 Request: ${location}, ${time}min, ${pace}km/h`);

    // Validate input
    if (!location || !time || !pace) {
      return error(400, 'Missing location, time, or pace');
    }

    // GEOCODE
    const coords = await geocodeLocation(location);
    if (!coords) return error(400, 'Location not found');
    const [lat, lng] = coords;
    console.log(`✅ Geocoded: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);

    // TARGET DISTANCE
    const targetKm = (time / 60) * pace;
    console.log(`📏 Target distance: ${targetKm.toFixed(1)}km`);

    // FETCH WAYS
    const radius = Math.max(500, Math.min(4000, targetKm * 2000));
    console.log(`🗺️  Fetching ways (radius ${radius}m)...`);
    
    const ways = await fetchAllWays(lat, lng, radius);
    console.log(`📊 Fetched: ${ways.length} ways`);

    if (ways.length === 0) {
      return error(400, 'No map data for this location');
    }

    // WAYS ALREADY SCORED - just filter
    console.log('⭐ Filtering walkable ways...');
    const good = ways.filter(w => w.score >= 0.2);
    console.log(`✅ ${good.length} walkable ways`);

    if (good.length < 3) {
      return error(400, `Only ${good.length} walkable ways - not enough for a route`);
    }

    // BUILD GRAPH
    console.log('🔗 Building graph...');
    const graph = buildGraph(good, lat, lng);
    console.log(`✅ Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

    if (graph.nodes.length < 3) {
      return error(400, 'Graph too small');
    }

    // ROUTE
    console.log('🧭 Generating route...');
    const route = genRoute(graph, lat, lng, targetKm);

    if (!route || !route.coords || route.coords.length < 3) {
      return error(400, 'Route generation failed');
    }

    console.log(`✅ Route: ${route.dist.toFixed(1)}km, ${route.coords.length} points`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        coordinates: route.coords,
        distance: route.dist,
        elevation: Math.round(50 + route.dist / 2),
        duration: time,
        location,
        pattern: 'intelligent-pedestrian',
        success: true
      })
    };

  } catch (err) {
    console.error('❌ ERROR:', err.message);
    console.error('Stack:', err.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: `Server error: ${err.message}` })
    };
  }
};

// ============================================================
// GEOCODE
// ============================================================

async function geocodeLocation(location) {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`,
      { headers: { 'User-Agent': 'Stroll' }, timeout: 10000 }
    );
    const data = await response.json();
    return data && data.length > 0 ? [parseFloat(data[0].lat), parseFloat(data[0].lon)] : null;
  } catch (err) {
    console.error('Geocode error:', err.message);
    return null;
  }
}

// ============================================================
// FETCH WAYS
// ============================================================

async function fetchAllWays(lat, lng, radius) {
  const deg = radius / 111000;
  const bbox = `${lat - deg},${lng - deg},${lat + deg},${lng + deg}`;
  
  const query = `[bbox:${bbox}];(way["highway"];way["leisure"="park"];);out geom;`;

  try {
    console.log(`  Overpass query bbox=${bbox.substring(0, 30)}...`);
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
      timeout: 30000
    });

    if (!response.ok) {
      console.warn(`  Overpass: status ${response.status}`);
      return [];
    }

    const data = await response.json();
    if (!data.ways) {
      console.warn('  No ways in response');
      return [];
    }

    const ways = [];
    for (const w of data.ways) {
      if (!w.geometry || w.geometry.length < 2) continue;
      const score = scoreWay(w);
      ways.push({
        id: w.id,
        nodes: w.geometry.map(g => ({ lat: g.lat, lon: g.lon })),
        tags: w.tags || {},
        score: score
      });
    }

    console.log(`  Parsed: ${ways.length} ways with geometry`);
    return ways;

  } catch (err) {
    console.error('  Fetch error:', err.message);
    return [];
  }
}

// ============================================================
// SCORING
// ============================================================

function scoreWay(way) {
  const t = way.tags;
  
  // Blocks
  if (t.access === 'private' || t.foot === 'no') return 0;
  
  // Base scores
  if (t.highway === 'footway') return 1.0;
  if (t.highway === 'pedestrian') return 0.9;
  if (t.highway === 'path') return 0.85;
  if (t.leisure === 'park') return 0.9;
  if (t.highway === 'track') return 0.7;
  
  // Regular roads: start at 0.3, boost for features
  let score = 0.3;
  
  if (t.sidewalk) score += 0.2;
  if (t.foot === 'designated') score += 0.2;
  if (t.lit === 'yes') score += 0.1;
  
  // Speed penalty
  const speed = parseInt(t.maxspeed);
  if (!isNaN(speed)) {
    if (speed >= 70) score *= 0.4;
    else if (speed >= 50) score *= 0.7;
    else if (speed >= 40) score *= 0.85;
  } else if (['motorway', 'trunk', 'primary'].includes(t.highway)) {
    score *= 0.6;
  }
  
  return Math.max(0, Math.min(1, score));
}

// ============================================================
// GRAPH
// ============================================================

function buildGraph(ways, lat, lng) {
  const nodes = new Map();
  const edges = [];
  let id = 0;

  function getNode(lat, lon) {
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (!nodes.has(key)) {
      nodes.set(key, {
        id: id++,
        lat, lon,
        dist: haversine(lat, lon, lat, lng),
        edges: []
      });
    }
    return nodes.get(key);
  }

  for (const way of ways) {
    const wayNodes = way.nodes.map(n => getNode(n.lat, n.lon));
    for (let i = 0; i < wayNodes.length - 1; i++) {
      const from = wayNodes[i];
      const to = wayNodes[i + 1];
      const d = haversine(from.lat, from.lon, to.lat, to.lon);
      edges.push({ from: from.id, to: to.id, d, score: way.score });
      from.edges.push(edges.length - 1);
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges
  };
}

// ============================================================
// ROUTE GENERATION
// ============================================================

function genRoute(graph, lat, lng, targetDist) {
  const { nodes, edges } = graph;
  
  // Create node lookup
  const nodeById = {};
  for (const n of nodes) {
    nodeById[n.id] = n;
  }
  
  let current = nodes.reduce((a, b) => b.dist < a.dist ? b : a);
  const route = [current];
  const visited = new Set([current.id]);
  let dist = 0;
  let direction = 'out';
  const threshold = targetDist * 0.75;

  for (let i = 0; i < 500 && dist < targetDist * 1.2; i++) {
    const available = (edges.filter(e => e.from === current.id && !visited.has(e.to)) || []);
    
    if (available.length === 0) break;

    let next;
    if (direction === 'out' && dist < threshold) {
      // Go away from center
      next = available.reduce((a, b) => {
        const an = nodeById[b.to];
        const bn = nodeById[a.to];
        return an.dist > bn.dist ? b : a;
      });
    } else {
      // Come back
      direction = 'home';
      next = available.reduce((a, b) => {
        const an = nodeById[b.to];
        const bn = nodeById[a.to];
        return an.dist < bn.dist ? b : a;
      });
    }

    if (!next) break;

    const nextNode = nodeById[next.to];
    dist += next.d;
    visited.add(nextNode.id);
    route.push(nextNode);
    current = nextNode;
  }

  return {
    coords: route.map(n => [n.lat, n.lon]),
    dist
  };
}

// ============================================================
// UTILS
// ============================================================

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function error(code, msg) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: msg })
  };
}
