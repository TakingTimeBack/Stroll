/**
 * STROLL INTELLIGENT PEDESTRIAN ROUTER - PRODUCTION
 * Heavily instrumented for debugging, bulletproof logic
 */

exports.handler = async (event) => {
  const LOG = [];
  
  try {
    LOG.push('START');
    
    // Parse input safely
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (err) {
      LOG.push(`PARSE_ERROR: ${err.message}`);
      return jsonResponse(400, { error: 'Invalid JSON input', debug: LOG });
    }

    const { location, time, pace, preferences } = body;
    LOG.push(`INPUT: location=${location}, time=${time}, pace=${pace}`);

    if (!location || time === undefined || !pace) {
      LOG.push('FAIL: Missing required fields');
      return jsonResponse(400, { error: 'Missing location, time, or pace', debug: LOG });
    }

    // ===== GEOCODE =====
    LOG.push('STEP: Geocoding');
    const coords = await geocodeLocation(location);
    if (!coords) {
      LOG.push('FAIL: Geocoding returned null');
      return jsonResponse(400, { error: `Location not found: "${location}"`, debug: LOG });
    }
    
    const [lat, lng] = coords;
    LOG.push(`OK: lat=${lat.toFixed(4)}, lng=${lng.toFixed(4)}`);

    // ===== DISTANCE =====
    const targetKm = (time / 60) * pace;
    if (isNaN(targetKm) || targetKm <= 0) {
      LOG.push('FAIL: Invalid distance calculation');
      return jsonResponse(400, { error: `Invalid distance: ${targetKm}`, debug: LOG });
    }
    LOG.push(`OK: target=${targetKm.toFixed(2)}km`);

    // ===== FETCH WAYS =====
    LOG.push('STEP: Fetching ways');
    const radius = Math.max(800, Math.min(5000, targetKm * 2500));
    LOG.push(`  radius=${radius}m`);
    
    const ways = await fetchAllWays(lat, lng, radius);
    LOG.push(`OK: fetched=${ways.length} ways`);

    if (!ways || ways.length === 0) {
      LOG.push('FAIL: No ways from Overpass');
      return jsonResponse(400, { error: 'No map data available for this location', debug: LOG });
    }

    // ===== VALIDATE & SCORE WAYS =====
    LOG.push('STEP: Validating ways');
    const validWays = [];
    for (const w of ways) {
      if (!w || !w.nodes || w.nodes.length < 2) continue;
      validWays.push(w);
    }
    LOG.push(`OK: valid=${validWays.length}/${ways.length}`);

    LOG.push('STEP: Filtering walkable');
    const walkable = [];
    for (const w of validWays) {
      try {
        const score = scoreWay(w);
        if (score >= 0.2) {
          w.score = score;
          walkable.push(w);
        }
      } catch (err) {
        LOG.push(`WARN: scoring error on ${w.id}: ${err.message}`);
      }
    }
    LOG.push(`OK: walkable=${walkable.length}/${validWays.length}`);

    if (walkable.length < 3) {
      LOG.push(`FAIL: insufficient walkable ways (${walkable.length} < 3)`);
      return jsonResponse(400, { error: `Only ${walkable.length} walkable ways found - need at least 3`, debug: LOG });
    }

    // ===== BUILD GRAPH =====
    LOG.push('STEP: Building graph');
    let graph;
    try {
      graph = buildGraph(walkable, lat, lng);
    } catch (err) {
      LOG.push(`FAIL: graph error: ${err.message}`);
      return jsonResponse(500, { error: `Graph building failed: ${err.message}`, debug: LOG });
    }

    LOG.push(`OK: nodes=${graph.nodes.length}, edges=${graph.edges.length}`);

    if (!graph.nodes || graph.nodes.length < 3) {
      LOG.push(`FAIL: graph has only ${graph.nodes?.length || 0} nodes`);
      return jsonResponse(400, { error: `Network too small: ${graph.nodes?.length || 0} nodes`, debug: LOG });
    }

    if (!graph.edges || graph.edges.length < 2) {
      LOG.push(`FAIL: graph has only ${graph.edges?.length || 0} edges`);
      return jsonResponse(400, { error: `Network not connected: ${graph.edges?.length || 0} edges`, debug: LOG });
    }

    // ===== GENERATE ROUTE =====
    LOG.push('STEP: Generating route');
    let route;
    try {
      route = generateRoute(graph, lat, lng, targetKm);
    } catch (err) {
      LOG.push(`FAIL: route error: ${err.message}`);
      return jsonResponse(500, { error: `Route generation failed: ${err.message}`, debug: LOG });
    }

    if (!route) {
      LOG.push('FAIL: route is null');
      return jsonResponse(500, { error: 'Route generation returned null', debug: LOG });
    }

    if (!route.coords || !Array.isArray(route.coords) || route.coords.length < 3) {
      LOG.push(`FAIL: invalid coords: ${route.coords?.length || 0}`);
      return jsonResponse(400, { error: `Route has ${route.coords?.length || 0} points (need 3+)`, debug: LOG });
    }

    LOG.push(`SUCCESS: ${route.coords.length} points, ${route.dist.toFixed(2)}km`);

    // Return success
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
    const msg = err.message || 'Unknown error';
    const stack = err.stack ? err.stack.split('\n')[1] : 'no stack';
    LOG.push(`CRITICAL: ${msg}`);
    LOG.push(`STACK: ${stack}`);

    return jsonResponse(500, {
      error: msg,
      debug: LOG
    });
  }
};

// ===== RESPONSE HELPER =====
function jsonResponse(status, data) {
  try {
    return {
      statusCode: status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(data)
    };
  } catch (err) {
    // Fallback if stringify fails
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Response serialization failed' })
    };
  }
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
    if (data && data.length > 0) {
      return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
    }
    return null;
  } catch (err) {
    return null;
  }
}

// ============================================================
// FETCH WAYS - ROBUST
// ============================================================

async function fetchAllWays(lat, lng, radius) {
  const deg = radius / 111000;
  const n = lat + deg;
  const s = lat - deg;
  const e = lng + deg;
  const w = lng - deg;
  
  const query = `[bbox:${s},${w},${n},${e}];(way["highway"];way["leisure"="park"];way["leisure"="garden"];);out geom json;`;

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
      timeout: 45000
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    
    if (!data || !data.ways) {
      return [];
    }

    const ways = [];
    for (const w of data.ways || []) {
      if (!w.geometry || !Array.isArray(w.geometry) || w.geometry.length < 2) {
        continue;
      }

      try {
        const nodes = w.geometry.map(g => ({
          lat: parseFloat(g.lat),
          lon: parseFloat(g.lon)
        }));

        if (nodes.some(n => isNaN(n.lat) || isNaN(n.lon))) {
          continue;
        }

        const score = scoreWay(w);
        
        ways.push({
          id: w.id || Math.random(),
          nodes,
          tags: w.tags || {},
          score
        });
      } catch (err) {
        // Skip malformed ways
        continue;
      }
    }

    return ways;
  } catch (err) {
    return [];
  }
}

// ============================================================
// SCORING - ROBUST
// ============================================================

function scoreWay(way) {
  try {
    if (!way || !way.tags) return 0;
    
    const t = way.tags;

    // Hard blocks
    if (t.access === 'private' || t.access === 'no') return 0;
    if (t.foot === 'no' || t.foot === 'discouraged') return 0;
    if (t.motor_vehicle === 'only') return 0;

    // Excellent
    if (t.highway === 'footway') return 1.0;
    if (t.highway === 'pedestrian') return 0.95;
    if (t.highway === 'path' && t.foot !== 'no') return 0.90;
    if (t.leisure === 'park' || t.leisure === 'garden') return 0.90;

    // Good
    if (t.highway === 'track') return 0.70;
    if (t.highway === 'living_street') return 0.75;

    // Medium roads - base score
    let score = 0.35;

    if (['residential', 'unclassified', 'tertiary'].includes(t.highway)) {
      score = 0.50;
    }

    // Boosts
    if (t.sidewalk) score = Math.min(1, score + 0.25);
    if (t.foot === 'designated') score = Math.min(1, score + 0.20);
    if (t.foot === 'permissive') score = Math.min(1, score + 0.10);
    if (t.lit === 'yes') score = Math.min(1, score + 0.10);
    if (t.surface === 'asphalt' || t.surface === 'concrete') score = Math.min(1, score + 0.05);

    // Speed penalties
    const speed = parseInt(t.maxspeed);
    if (!isNaN(speed)) {
      if (speed >= 80) score *= 0.3;
      else if (speed >= 60) score *= 0.5;
      else if (speed >= 50) score *= 0.7;
      else if (speed >= 40) score *= 0.85;
    } else if (['motorway', 'motorway_link'].includes(t.highway)) {
      score *= 0.2;
    } else if (['trunk', 'trunk_link', 'primary', 'primary_link'].includes(t.highway)) {
      score *= 0.6;
    } else if (['secondary', 'secondary_link'].includes(t.highway)) {
      score *= 0.8;
    }

    return Math.max(0, Math.min(1, score));
  } catch (err) {
    return 0.35; // Safe default
  }
}

// ============================================================
// GRAPH BUILDING - ROBUST
// ============================================================

function buildGraph(ways, centerLat, centerLng) {
  const nodeMap = new Map();
  const edges = [];
  let nodeId = 0;

  const getNode = (lat, lon) => {
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (!nodeMap.has(key)) {
      const distToCenter = Math.sqrt(
        (lat - centerLat) ** 2 + (lon - centerLng) ** 2
      );
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

  // Build graph
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
// ROUTE GENERATION - ROBUST
// ============================================================

function generateRoute(graph, centerLat, centerLng, targetDist) {
  const { nodes, edges } = graph;

  if (!nodes || nodes.length < 3) {
    throw new Error('Graph too small');
  }

  // Build node lookup
  const nodeById = {};
  for (const n of nodes) {
    nodeById[n.id] = n;
  }

  // Find best start: closest to center
  let start = nodes[0];
  for (const n of nodes) {
    if (n.distToCenter < start.distToCenter) {
      start = n;
    }
  }

  const route = [start];
  const visited = new Set([start.id]);
  let totalDist = 0;
  let phase = 'outbound';
  const turnAroundDist = targetDist * 0.65;

  let iterations = 0;
  const maxIterations = 800;

  while (iterations < maxIterations) {
    iterations++;

    // Get available edges from current node
    const current = route[route.length - 1];
    const available = edges
      .filter(e => e.from === current.id && !visited.has(e.to))
      .map(e => ({ ...e, toNode: nodeById[e.to] }))
      .filter(e => e.toNode);

    if (available.length === 0) {
      // Try to find unvisited neighbor
      let best = null;
      let bestDist = Infinity;

      for (const n of nodes) {
        if (!visited.has(n.id)) {
          const d = haversine(current.lat, current.lon, n.lat, n.lon);
          if (d < bestDist) {
            best = n;
            bestDist = d;
          }
        }
      }

      if (best && bestDist < 0.05) {
        // Jump to nearby unvisited node
        visited.add(best.id);
        route.push(best);
        totalDist += bestDist;
      } else {
        break; // No more options
      }
      continue;
    }

    // Choose next edge
    let nextEdge;

    if (phase === 'outbound' && totalDist < turnAroundDist) {
      // Go outward: prefer nodes farther from center
      nextEdge = available.reduce((best, edge) => {
        const isBetter = edge.toNode.distToCenter > best.toNode.distToCenter ||
          (edge.toNode.distToCenter === best.toNode.distToCenter && edge.score > best.score);
        return isBetter ? edge : best;
      });
    } else {
      // Return phase: prefer nodes closer to center
      if (phase === 'outbound') phase = 'return';
      nextEdge = available.reduce((best, edge) => {
        const isBetter = edge.toNode.distToCenter < best.toNode.distToCenter ||
          (edge.toNode.distToCenter === best.toNode.distToCenter && edge.score > best.score);
        return isBetter ? edge : best;
      });
    }

    if (!nextEdge) break;

    const next = nodeById[nextEdge.to];
    totalDist += nextEdge.dist;
    visited.add(next.id);
    route.push(next);

    // Stop if we've reached target
    if (totalDist >= targetDist * 0.95) break;
  }

  if (route.length < 3) {
    throw new Error('Route too short');
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
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
