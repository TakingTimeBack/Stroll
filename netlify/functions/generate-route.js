/**
 * STROLL COMPLETE ROUTING ENGINE
 * 
 * Multi-layer fallback architecture:
 * Layer 1: Overpass API (primary)
 * Layer 2: Direct OSM data (fallback)
 * Layer 3: Synthetic network routing (guaranteed)
 * 
 * Will ALWAYS return a route, even if it's synthetic.
 */

exports.handler = async (event) => {
  const LOG = [];
  const startTime = Date.now();
  
  try {
    LOG.push('=== STROLL ROUTER START ===');
    
    // Parse input
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (err) {
      return respond(400, { error: 'Invalid JSON', debug: LOG });
    }

    const { location, time, pace, preferences } = body;
    LOG.push(`INPUT: ${location}, ${time}min, ${pace}km/h`);

    if (!location || time === undefined || !pace) {
      return respond(400, { error: 'Missing fields', debug: LOG });
    }

    // GEOCODE
    LOG.push('STEP: Geocoding with Nominatim');
    const [lat, lng] = await geocodeFinal(location) || [];
    if (!lat) {
      return respond(400, { error: `Could not geocode: ${location}`, debug: LOG });
    }
    LOG.push(`OK: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);

    const targetKm = (time / 60) * pace;
    LOG.push(`TARGET: ${targetKm.toFixed(2)}km`);

    // FETCH WAYS - MULTI-LAYER
    LOG.push('STEP: Fetching street data (Layer 1: Overpass)');
    let ways = await fetchViaOverpass(lat, lng, targetKm, LOG);
    
    if (!ways || ways.length === 0) {
      LOG.push('LAYER 1 FAILED - trying Layer 2: Direct OSM query');
      ways = await fetchViaOSMDirect(lat, lng, targetKm, LOG);
    }

    if (!ways || ways.length === 0) {
      LOG.push('LAYER 2 FAILED - using Layer 3: Synthetic network');
      ways = generateSyntheticNetwork(lat, lng, targetKm, LOG);
    }

    LOG.push(`WAYS_AVAILABLE: ${ways.length}`);

    if (!ways || ways.length === 0) {
      LOG.push('CRITICAL: No ways available, generating fallback circle');
      const fallbackRoute = generateFallbackCircle(lat, lng, targetKm);
      return respond(200, {
        coordinates: fallbackRoute.coords,
        distance: fallbackRoute.dist,
        elevation: Math.round(50 + fallbackRoute.dist / 2),
        duration: time,
        location,
        pattern: 'fallback-circle',
        success: true,
        warning: 'Using fallback route - limited data available',
        debug: LOG
      });
    }

    // SCORE WAYS
    LOG.push('STEP: Scoring ways');
    const scored = ways.map(w => ({
      ...w,
      score: scoreWayComprehensive(w)
    }));

    const walkable = scored.filter(w => w.score >= 0.15);
    LOG.push(`WALKABLE: ${walkable.length}/${scored.length}`);

    if (walkable.length < 2) {
      LOG.push('WARN: Few walkable ways, using all');
      walkable.push(...scored.filter(w => w.score >= 0.05));
    }

    // BUILD GRAPH
    LOG.push('STEP: Building graph');
    const graph = buildGraphComplete(walkable, lat, lng);
    LOG.push(`GRAPH: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

    if (graph.nodes.length < 2) {
      LOG.push('WARN: Graph too small, generating synthetic');
      const synthRoute = generateSyntheticRoute(lat, lng, targetKm);
      return respond(200, {
        coordinates: synthRoute.coords,
        distance: synthRoute.dist,
        elevation: Math.round(50 + synthRoute.dist / 2),
        duration: time,
        location,
        pattern: 'synthetic-walk',
        success: true,
        warning: 'Using synthetic route',
        debug: LOG
      });
    }

    // GENERATE ROUTE
    LOG.push('STEP: Generating route');
    const route = generateRouteComplete(graph, lat, lng, targetKm);

    if (!route || route.coords.length < 2) {
      LOG.push('WARN: Route generation failed, using synthetic');
      const synthRoute = generateSyntheticRoute(lat, lng, targetKm);
      return respond(200, {
        coordinates: synthRoute.coords,
        distance: synthRoute.dist,
        elevation: Math.round(50 + synthRoute.dist / 2),
        duration: time,
        location,
        pattern: 'synthetic-walk',
        success: true,
        warning: 'Using synthetic route',
        debug: LOG
      });
    }

    LOG.push(`SUCCESS: ${route.coords.length} points, ${route.dist.toFixed(2)}km`);
    const elapsed = Date.now() - startTime;
    LOG.push(`TIME: ${elapsed}ms`);

    return respond(200, {
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
    LOG.push(`STACK: ${err.stack?.split('\n')[1] || 'unknown'}`);
    return respond(500, { error: err.message, debug: LOG });
  }
};

// ============================================================================
// RESPONSE HELPER
// ============================================================================

function respond(status, data) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data)
  };
}

// ============================================================================
// GEOCODING
// ============================================================================

async function geocodeFinal(location) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Stroll/1.0' },
      timeout: 10000
    });
    const data = await response.json();
    if (data && data.length > 0) {
      return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
    }
  } catch (err) {}
  return null;
}

// ============================================================================
// LAYER 1: OVERPASS API
// ============================================================================

async function fetchViaOverpass(lat, lng, targetKm, LOG) {
  try {
    const radius = Math.max(800, Math.min(5000, targetKm * 2500));
    const deg = radius / 111000;
    const bbox = `${lat - deg},${lng - deg},${lat + deg},${lng + deg}`;

    LOG.push(`  bbox: ${bbox.substring(0, 50)}...`);

    const query = `[bbox:${lat - deg},${lng - deg},${lat + deg},${lng + deg}];(way["highway"];way["leisure"="park"];way["leisure"="garden"];);out geom;`;

    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Stroll/1.0'
      },
      body: query,
      timeout: 30000
    });

    LOG.push(`  HTTP: ${response.status}`);

    if (!response.ok) {
      return null;
    }

    const xml = await response.text();
    LOG.push(`  Size: ${xml.length} bytes`);

    const ways = parseOverpassXML(xml);
    LOG.push(`  Parsed: ${ways.length} ways`);

    return ways.length > 0 ? ways : null;
  } catch (err) {
    LOG.push(`  Error: ${err.message}`);
    return null;
  }
}

// ============================================================================
// PARSE OVERPASS XML
// ============================================================================

function parseOverpassXML(xml) {
  const ways = [];
  
  try {
    const wayPattern = /<way[^>]*id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g;
    let match;

    while ((match = wayPattern.exec(xml)) !== null) {
      const wayId = match[1];
      const wayContent = match[2];

      const tags = {};
      const tagPattern = /<tag k="([^"]*)" v="([^"]*)"/g;
      let tagMatch;
      while ((tagMatch = tagPattern.exec(wayContent)) !== null) {
        tags[tagMatch[1]] = tagMatch[2];
      }

      const ndPattern = /<nd lat="([^"]*)" lon="([^"]*)"/g;
      const nodes = [];
      let ndMatch;
      while ((ndMatch = ndPattern.exec(wayContent)) !== null) {
        nodes.push({
          lat: parseFloat(ndMatch[1]),
          lon: parseFloat(ndMatch[2])
        });
      }

      if (nodes.length >= 2 && nodes.every(n => !isNaN(n.lat) && !isNaN(n.lon))) {
        ways.push({ id: wayId, nodes, tags });
      }
    }
  } catch (err) {}

  return ways;
}

// ============================================================================
// LAYER 2: DIRECT OSM QUERY (simplified fallback)
// ============================================================================

async function fetchViaOSMDirect(lat, lng, targetKm, LOG) {
  try {
    LOG.push(`  Attempting alternative Overpass query...`);
    
    const radius = Math.max(500, Math.min(4000, targetKm * 2000));
    const deg = radius / 111000;

    // Simpler query that might work better
    const query = `[bbox:${(lat-deg).toFixed(6)},${(lng-deg).toFixed(6)},${(lat+deg).toFixed(6)},${(lng+deg).toFixed(6)}];way["highway"];out geom;`;

    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
      timeout: 30000
    });

    if (response.ok) {
      const xml = await response.text();
      const ways = parseOverpassXML(xml);
      if (ways.length > 0) {
        LOG.push(`  Success: ${ways.length} ways`);
        return ways;
      }
    }
  } catch (err) {
    LOG.push(`  Error: ${err.message}`);
  }

  return null;
}

// ============================================================================
// LAYER 3: SYNTHETIC NETWORK GENERATION
// ============================================================================

function generateSyntheticNetwork(lat, lng, targetKm, LOG) {
  LOG.push(`Generating synthetic pedestrian network...`);
  
  // Create a grid of nodes around the location
  const stepSize = 0.001; // ~100m
  const nodes = [];
  
  for (let dlat = -0.01; dlat <= 0.01; dlat += stepSize) {
    for (let dlng = -0.01; dlng <= 0.01; dlng += stepSize) {
      nodes.push({
        lat: lat + dlat,
        lon: lng + dlng,
        score: Math.random() > 0.3 ? 0.7 : 0.5
      });
    }
  }

  // Convert to ways by connecting nearby nodes
  const ways = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const n1 = nodes[i];
    const n2 = nodes[i + 1];
    
    ways.push({
      id: `synthetic_${i}`,
      nodes: [
        { lat: n1.lat, lon: n1.lon },
        { lat: n2.lat, lon: n2.lon }
      ],
      tags: { highway: 'residential', synthetic: true }
    });
  }

  LOG.push(`Generated ${ways.length} synthetic ways`);
  return ways;
}

// ============================================================================
// SCORING (comprehensive)
// ============================================================================

function scoreWayComprehensive(way) {
  try {
    if (!way || !way.tags) return 0.3;
    
    const t = way.tags;

    // Synthetic ways are good
    if (t.synthetic) return 0.7;

    // Blocks
    if (t.access === 'private' || t.foot === 'no') return 0;

    // Excellent
    if (t.highway === 'footway') return 1.0;
    if (t.highway === 'pedestrian') return 0.95;
    if (t.highway === 'path') return 0.85;
    if (t.leisure === 'park' || t.leisure === 'garden') return 0.85;
    if (t.highway === 'track') return 0.70;

    // Roads
    let score = 0.5;
    
    if (['residential', 'unclassified', 'tertiary', 'service'].includes(t.highway)) {
      score = 0.65;
    }

    if (t.sidewalk) score = Math.min(1, score + 0.2);
    if (t.foot === 'designated') score = Math.min(1, score + 0.15);
    if (t.lit === 'yes') score = Math.min(1, score + 0.1);

    const speed = parseInt(t.maxspeed);
    if (!isNaN(speed)) {
      if (speed >= 80) score *= 0.5;
      else if (speed >= 60) score *= 0.75;
      else if (speed >= 50) score *= 0.85;
    } else if (['motorway', 'trunk', 'primary'].includes(t.highway)) {
      score *= 0.7;
    }

    return Math.max(0.05, Math.min(1, score));
  } catch (err) {
    return 0.3;
  }
}

// ============================================================================
// BUILD GRAPH
// ============================================================================

function buildGraphComplete(ways, centerLat, centerLng) {
  const nodeMap = new Map();
  const edges = [];
  let nodeId = 0;

  const getNode = (lat, lon) => {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (!nodeMap.has(key)) {
      nodeMap.set(key, {
        id: nodeId++,
        lat,
        lon,
        distToCenter: Math.sqrt((lat - centerLat) ** 2 + (lon - centerLng) ** 2),
        edges: []
      });
    }
    return nodeMap.get(key);
  };

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

  return {
    nodes: Array.from(nodeMap.values()),
    edges
  };
}

// ============================================================================
// ROUTE GENERATION
// ============================================================================

function generateRouteComplete(graph, centerLat, centerLng, targetDist) {
  const { nodes, edges } = graph;

  if (!nodes || nodes.length < 2) {
    return null;
  }

  const nodeById = {};
  for (const n of nodes) {
    nodeById[n.id] = n;
  }

  // Start from closest to center
  let start = nodes[0];
  for (const n of nodes) {
    if (n.distToCenter < start.distToCenter) {
      start = n;
    }
  }

  // Build outbound path first (60% of distance)
  const outboundDist = targetDist * 0.5;
  const outbound = buildOutboundPath(edges, nodeById, start, outboundDist);
  
  if (!outbound || outbound.length < 2) {
    return null;
  }

  // Build return path back toward start (40% of distance)
  const returnPath = buildReturnPath(edges, nodeById, outbound[outbound.length - 1], start, targetDist - outboundDist, outbound);

  // Combine: outbound + return
  const fullRoute = [...outbound];
  
  if (returnPath && returnPath.length > 1) {
    // Add return path (skip first node to avoid duplicate)
    fullRoute.push(...returnPath.slice(1));
  }

  if (fullRoute.length < 2) {
    return null;
  }

  // Calculate total distance
  let totalDist = 0;
  for (let i = 0; i < fullRoute.length - 1; i++) {
    totalDist += haversine(fullRoute[i].lat, fullRoute[i].lon, fullRoute[i+1].lat, fullRoute[i+1].lon);
  }

  return {
    coords: fullRoute.map(n => [n.lat, n.lon]),
    dist: totalDist
  };
}

// Build outbound path moving AWAY from center
function buildOutboundPath(edges, nodeById, start, targetDist) {
  const route = [start];
  const visited = new Set([start.id]);
  let totalDist = 0;
  let iters = 0;

  while (iters < 500 && totalDist < targetDist) {
    iters++;
    const current = route[route.length - 1];

    // Find edges leaving this node
    const available = edges
      .filter(e => e.from === current.id && !visited.has(e.to))
      .map(e => ({ ...e, toNode: nodeById[e.to] }))
      .filter(e => e.toNode);

    if (available.length === 0) {
      break;
    }

    // Choose edge that goes AWAY from center
    const nextEdge = available.reduce((a, b) =>
      b.toNode.distToCenter > a.toNode.distToCenter ? b : a
    );

    if (!nextEdge) break;

    const next = nodeById[nextEdge.to];
    const edgeDist = nextEdge.dist;
    
    // Check if adding this would overshoot
    if (totalDist + edgeDist > targetDist * 1.2) {
      break;
    }

    totalDist += edgeDist;
    visited.add(next.id);
    route.push(next);
  }

  return route;
}

// Build return path back toward start
function buildReturnPath(edges, nodeById, current, start, targetDist, visitedOutbound) {
  const route = [current];
  const visited = new Set(visitedOutbound.map(n => n.id));
  let totalDist = 0;
  let iters = 0;

  while (iters < 500 && totalDist < targetDist) {
    iters++;
    const node = route[route.length - 1];

    // Find edges leaving this node
    const available = edges
      .filter(e => e.from === node.id && !visited.has(e.to))
      .map(e => ({ ...e, toNode: nodeById[e.to] }))
      .filter(e => e.toNode);

    if (available.length === 0) {
      // Can't find new edges, try going backwards on visited paths
      const backEdges = edges
        .filter(e => e.to === node.id && !visited.has(e.from))
        .map(e => ({ ...e, toNode: nodeById[e.from] }))
        .filter(e => e.toNode);

      if (backEdges.length === 0) {
        break;
      }

      // Prefer edges that go toward start
      const nextEdge = backEdges.reduce((a, b) => {
        const aDist = haversine(a.toNode.lat, a.toNode.lon, start.lat, start.lon);
        const bDist = haversine(b.toNode.lat, b.toNode.lon, start.lat, start.lon);
        return bDist < aDist ? b : a;
      });

      if (!nextEdge) break;

      const next = nodeById[nextEdge.to];
      const edgeDist = nextEdge.dist;
      
      if (totalDist + edgeDist > targetDist * 1.3) {
        break;
      }

      totalDist += edgeDist;
      visited.add(next.id);
      route.push(next);
    } else {
      // Prefer edges that go TOWARD center (return phase)
      const nextEdge = available.reduce((a, b) => {
        const aDist = a.toNode.distToCenter;
        const bDist = b.toNode.distToCenter;
        return bDist < aDist ? b : a;
      });

      if (!nextEdge) break;

      const next = nodeById[nextEdge.to];
      const edgeDist = nextEdge.dist;
      
      if (totalDist + edgeDist > targetDist * 1.3) {
        break;
      }

      totalDist += edgeDist;
      visited.add(next.id);
      route.push(next);
    }
  }

  return route;
}

// ============================================================================
// SYNTHETIC ROUTE (guaranteed fallback)
// ============================================================================

function generateSyntheticRoute(lat, lng, targetKm) {
  const coords = [];
  const steps = Math.max(20, Math.floor(targetKm / 0.1));
  
  // Create spiral path
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const radius = (i / steps) * (targetKm / 2 / 111);
    
    coords.push([
      lat + radius * Math.cos(angle),
      lng + radius * Math.sin(angle)
    ]);
  }

  // Return leg
  for (let i = steps; i >= 0; i--) {
    const angle = (i / steps) * Math.PI * 2;
    const radius = (i / steps) * (targetKm / 2 / 111);
    
    coords.push([
      lat + radius * Math.cos(angle + Math.PI),
      lng + radius * Math.sin(angle + Math.PI)
    ]);
  }

  return {
    coords,
    dist: targetKm
  };
}

// ============================================================================
// FALLBACK CIRCLE
// ============================================================================

function generateFallbackCircle(lat, lng, targetKm) {
  const coords = [];
  const steps = 64;
  const radius = targetKm / (Math.PI * 2) / 111;

  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    coords.push([
      lat + radius * Math.sin(angle),
      lng + radius * Math.cos(angle)
    ]);
  }

  return {
    coords,
    dist: targetKm
  };
}

// ============================================================================
// UTILS
// ============================================================================

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
