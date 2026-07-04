/**
 * STROLL INTELLIGENT ROUTER - AGGRESSIVE MODE
 * Doesn't give up, logs everything, fights for routes
 */

exports.handler = async (event) => {
  const LOG = [];
  
  try {
    LOG.push('START');
    
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (err) {
      return jsonResponse(400, { error: 'Invalid JSON', debug: LOG });
    }

    const { location, time, pace } = body;
    LOG.push(`INPUT: location=${location}, time=${time}, pace=${pace}`);

    if (!location || time === undefined || !pace) {
      return jsonResponse(400, { error: 'Missing location, time, or pace', debug: LOG });
    }

    // ===== GEOCODE =====
    LOG.push('GEOCODING...');
    const coords = await geocodeLocation(location);
    if (!coords) {
      return jsonResponse(400, { error: `Location not found: ${location}`, debug: LOG });
    }
    
    const [lat, lng] = coords;
    LOG.push(`GEOCODED: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);

    // ===== DISTANCE =====
    const targetKm = (time / 60) * pace;
    LOG.push(`TARGET: ${targetKm.toFixed(2)}km`);

    // ===== FETCH WAYS - AGGRESSIVE =====
    LOG.push('FETCHING_WAYS...');
    const radius = Math.max(800, Math.min(5000, targetKm * 2500));
    LOG.push(`RADIUS: ${radius}m`);
    
    const ways = await fetchAllWaysAggressive(lat, lng, radius, LOG);
    LOG.push(`FETCHED: ${ways.length} ways`);

    if (!ways || ways.length === 0) {
      LOG.push('WARN: No ways - trying larger radius');
      const ways2 = await fetchAllWaysAggressive(lat, lng, radius * 1.5, LOG);
      if (ways2.length > 0) {
        ways.push(...ways2);
        LOG.push(`RECOVERED: ${ways.length} ways with larger radius`);
      }
    }

    if (ways.length === 0) {
      return jsonResponse(400, { error: 'No map data', debug: LOG });
    }

    // ===== SCORE WAYS - LENIENT =====
    LOG.push('SCORING...');
    const walkable = ways.filter(w => {
      try {
        const score = scoreWayLenient(w);
        w.score = score;
        return score >= 0.1; // VERY lenient threshold
      } catch (err) {
        w.score = 0.3; // Default safe score
        return true;
      }
    });

    LOG.push(`WALKABLE: ${walkable.length}/${ways.length}`);

    if (walkable.length < 2) {
      LOG.push('WARN: Very few walkable ways, using all ways anyway');
      walkable.length = 0;
      walkable.push(...ways);
    }

    // ===== BUILD GRAPH =====
    LOG.push('BUILDING_GRAPH...');
    let graph;
    try {
      graph = buildGraphAggressive(walkable, lat, lng);
    } catch (err) {
      LOG.push(`GRAPH_ERROR: ${err.message}`);
      return jsonResponse(500, { error: `Graph failed: ${err.message}`, debug: LOG });
    }

    LOG.push(`GRAPH: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

    if (graph.nodes.length < 2) {
      LOG.push('FAIL: Graph too small');
      return jsonResponse(400, { error: `Not enough nodes: ${graph.nodes.length}`, debug: LOG });
    }

    // ===== GENERATE ROUTE =====
    LOG.push('GENERATING_ROUTE...');
    let route;
    try {
      route = generateRouteAggressive(graph, lat, lng, targetKm);
    } catch (err) {
      LOG.push(`ROUTE_ERROR: ${err.message}`);
      return jsonResponse(500, { error: `Route failed: ${err.message}`, debug: LOG });
    }

    if (!route || !route.coords || route.coords.length < 2) {
      LOG.push(`FAIL: Route too short (${route?.coords?.length || 0} points)`);
      return jsonResponse(400, { error: `Route too short`, debug: LOG });
    }

    LOG.push(`SUCCESS: ${route.coords.length} points, ${route.dist.toFixed(2)}km`);

    return jsonResponse(200, {
      coordinates: route.coords,
      distance: parseFloat(route.dist.toFixed(2)),
      elevation: Math.round(50 + route.dist / 2),
      duration: time,
      location,
      pattern: 'intelligent-pedestrian',
      success: true,
      debug: LOG
    });

  } catch (err) {
    LOG.push(`CRITICAL: ${err.message}`);
    return jsonResponse(500, { error: err.message, debug: LOG });
  }
};

// ============================================================
// RESPONSE HELPER
// ============================================================

function jsonResponse(status, data) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(data)
  };
}

// ============================================================
// GEOCODE
// ============================================================

async function geocodeLocation(location) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Stroll' },
      timeout: 10000
    });
    const data = await response.json();
    return data && data.length > 0 ? [parseFloat(data[0].lat), parseFloat(data[0].lon)] : null;
  } catch (err) {
    return null;
  }
}

// ============================================================
// FETCH WAYS - AGGRESSIVE
// ============================================================

async function fetchAllWaysAggressive(lat, lng, radius, LOG) {
  const deg = radius / 111000;
  const n = lat + deg;
  const s = lat - deg;
  const e = lng + deg;
  const w = lng - deg;
  
  // Use JSON output
  const query = `[bbox:${s},${w},${n},${e}];(way["highway"];way["leisure"="park"];way["leisure"="garden"];);out geom json;`;

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
      timeout: 45000
    });

    if (!response.ok) {
      LOG.push(`OVERPASS_HTTP: ${response.status}`);
      return [];
    }

    const data = await response.json();
    
    if (!data.ways || !Array.isArray(data.ways)) {
      LOG.push(`NO_WAYS_ARRAY`);
      return [];
    }

    LOG.push(`OVERPASS_WAYS: ${data.ways.length}`);

    const ways = [];
    for (const w of data.ways) {
      if (!w.geometry || !Array.isArray(w.geometry) || w.geometry.length < 2) {
        continue;
      }

      try {
        const nodes = w.geometry.map(g => ({
          lat: parseFloat(g.lat),
          lon: parseFloat(g.lon)
        })).filter(n => !isNaN(n.lat) && !isNaN(n.lon));

        if (nodes.length < 2) continue;

        ways.push({
          id: w.id || Math.random(),
          nodes,
          tags: w.tags || {}
        });
      } catch (err) {
        continue;
      }
    }

    LOG.push(`PARSED_WAYS: ${ways.length}`);
    return ways;
  } catch (err) {
    LOG.push(`FETCH_ERROR: ${err.message}`);
    return [];
  }
}

// ============================================================
// SCORING - LENIENT
// ============================================================

function scoreWayLenient(way) {
  try {
    if (!way || !way.tags) return 0.3;
    
    const t = way.tags;

    // Hard blocks only
    if (t.access === 'private' || t.access === 'no') return 0;
    if (t.foot === 'no') return 0;

    // Excellent
    if (t.highway === 'footway') return 1.0;
    if (t.highway === 'pedestrian') return 0.95;
    if (t.highway === 'path') return 0.85;
    if (t.leisure === 'park' || t.leisure === 'garden') return 0.85;
    if (t.highway === 'track') return 0.75;

    // Roads - generous base
    let score = 0.5; // Start generous

    if (['residential', 'unclassified', 'tertiary', 'service'].includes(t.highway)) {
      score = 0.65;
    }

    // Boosts
    if (t.sidewalk) score = Math.min(1, score + 0.15);
    if (t.foot === 'designated') score = Math.min(1, score + 0.15);
    if (t.lit === 'yes') score = Math.min(1, score + 0.05);

    // Speed - less aggressive
    const speed = parseInt(t.maxspeed);
    if (!isNaN(speed)) {
      if (speed >= 80) score *= 0.5;
      else if (speed >= 60) score *= 0.75;
      else if (speed >= 50) score *= 0.85;
    } else if (['motorway', 'trunk', 'primary'].includes(t.highway)) {
      score *= 0.7;
    }

    return Math.max(0.1, Math.min(1, score)); // Never go below 0.1
  } catch (err) {
    return 0.3;
  }
}

// ============================================================
// GRAPH - AGGRESSIVE
// ============================================================

function buildGraphAggressive(ways, centerLat, centerLng) {
  const nodeMap = new Map();
  const edges = [];
  let nodeId = 0;

  const getNode = (lat, lon) => {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (!nodeMap.has(key)) {
      const distToCenter = Math.sqrt((lat - centerLat) ** 2 + (lon - centerLng) ** 2);
      nodeMap.set(key, {
        id: nodeId++,
        lat,
        lon,
        distToCenter,
        edges: []
      });
    }
    return nodeMap.get(key);
  };

  // Build from all ways
  for (const way of ways) {
    if (!way.nodes || way.nodes.length < 2) continue;

    const wayNodes = [];
    for (const n of way.nodes) {
      try {
        wayNodes.push(getNode(n.lat, n.lon));
      } catch (err) {
        continue;
      }
    }

    // Connect nodes
    for (let i = 0; i < wayNodes.length - 1; i++) {
      const from = wayNodes[i];
      const to = wayNodes[i + 1];
      const dist = haversine(from.lat, from.lon, to.lat, to.lon);
      
      edges.push({
        from: from.id,
        to: to.id,
        dist,
        score: way.score || 0.5
      });

      from.edges.push(edges.length - 1);
    }
  }

  const nodes = Array.from(nodeMap.values());
  return { nodes, edges, nodeMap };
}

// ============================================================
// ROUTE - AGGRESSIVE
// ============================================================

function generateRouteAggressive(graph, centerLat, centerLng, targetDist) {
  const { nodes, edges } = graph;

  if (!nodes || nodes.length < 2) {
    throw new Error('Not enough nodes');
  }

  // Start from closest to center
  let start = nodes[0];
  for (const n of nodes) {
    if (n.distToCenter < start.distToCenter) {
      start = n;
    }
  }

  const nodeById = {};
  for (const n of nodes) {
    nodeById[n.id] = n;
  }

  const route = [start];
  const visited = new Set([start.id]);
  let totalDist = 0;
  let phase = 'outbound';
  const turnAround = targetDist * 0.65;

  let iters = 0;
  const maxIters = 1000;

  while (iters < maxIters) {
    iters++;
    const current = route[route.length - 1];

    // Get available edges
    const available = edges
      .filter(e => e.from === current.id && !visited.has(e.to))
      .map(e => ({ ...e, toNode: nodeById[e.to] }))
      .filter(e => e.toNode);

    if (available.length === 0) {
      // Jump to nearest unvisited
      let best = null;
      let bestDist = Infinity;
      for (const n of nodes) {
        if (!visited.has(n.id)) {
          const d = haversine(current.lat, current.lon, n.lat, n.lon);
          if (d < bestDist && d < 0.1) { // Jump max 0.1km
            best = n;
            bestDist = d;
          }
        }
      }

      if (best) {
        visited.add(best.id);
        route.push(best);
        totalDist += bestDist;
      } else {
        break;
      }
      continue;
    }

    // Choose next
    let nextEdge;
    if (phase === 'outbound' && totalDist < turnAround) {
      nextEdge = available.reduce((a, b) =>
        b.toNode.distToCenter > a.toNode.distToCenter ? b : a
      );
    } else {
      if (phase === 'outbound') phase = 'return';
      nextEdge = available.reduce((a, b) =>
        b.toNode.distToCenter < a.toNode.distToCenter ? b : a
      );
    }

    if (!nextEdge) break;

    const next = nodeById[nextEdge.to];
    totalDist += nextEdge.dist;
    visited.add(next.id);
    route.push(next);

    if (totalDist >= targetDist * 0.9) break;
  }

  if (route.length < 2) {
    throw new Error('Route generation failed');
  }

  return {
    coords: route.map(n => [n.lat, n.lon]),
    dist: totalDist
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
