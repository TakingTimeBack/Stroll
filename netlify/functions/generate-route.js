/**
 * STROLL PEDESTRIAN GRAPH ROUTER
 * 
 * Query OSM for ONLY pedestrian infrastructure
 * Build local walking network graph
 * Route using Dijkstra on pedestrian-only paths
 * No major roads, guaranteed walkable routes
 */

exports.handler = async (event) => {
  const LOG = [];
  
  try {
    LOG.push('=== STROLL PEDESTRIAN GRAPH ROUTER ===');
    
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (err) {
      return respond(400, { error: 'Invalid JSON', debug: LOG });
    }

    const { location, time, pace } = body;
    LOG.push(`INPUT: ${location}, ${time}min, ${pace}km/h`);

    if (!location || time === undefined || !pace) {
      return respond(400, { error: 'Missing fields', debug: LOG });
    }

    // GEOCODE
    LOG.push('STEP: Geocoding');
    const [lat, lng] = await geocodeFinal(location) || [];
    if (!lat) {
      return respond(400, { error: `Could not geocode: ${location}`, debug: LOG });
    }
    LOG.push(`OK: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);

    const targetKm = (time / 60) * pace;
    LOG.push(`TARGET: ${targetKm.toFixed(2)}km`);

    // FETCH PEDESTRIAN INFRASTRUCTURE ONLY
    LOG.push('STEP: Fetching pedestrian ways');
    const searchRadius = Math.max(0.8, Math.min(2, targetKm / 2)); // Adaptive radius
    const pedestrianWays = await fetchPedestrianWays(lat, lng, searchRadius);
    LOG.push(`PEDESTRIAN_WAYS: ${pedestrianWays.length}`);

    if (!pedestrianWays || pedestrianWays.length < 5) {
      LOG.push('WARN: Few pedestrian ways, expanding search radius');
      const expandedWays = await fetchPedestrianWays(lat, lng, searchRadius * 2);
      pedestrianWays.push(...expandedWays);
      LOG.push(`EXPANDED: ${pedestrianWays.length} total`);
    }

    if (pedestrianWays.length < 3) {
      LOG.push('FAIL: Insufficient pedestrian infrastructure');
      const fallback = generateFallbackCircle(lat, lng, targetKm);
      return respond(200, {
        coordinates: fallback.coords,
        distance: fallback.dist,
        elevation: Math.round(50 + fallback.dist / 2),
        duration: time,
        location,
        pattern: 'fallback-circle',
        success: true,
        warning: 'Limited pedestrian data - using geometric route',
        debug: LOG
      });
    }

    // BUILD PEDESTRIAN GRAPH
    LOG.push('STEP: Building pedestrian network graph');
    const graph = buildPedestrianGraph(pedestrianWays, lat, lng);
    LOG.push(`GRAPH: ${graph.nodes.length} intersections, ${graph.edges.length} segments`);

    if (graph.nodes.length < 3) {
      LOG.push('FAIL: Graph too small');
      const fallback = generateFallbackCircle(lat, lng, targetKm);
      return respond(200, {
        coordinates: fallback.coords,
        distance: fallback.dist,
        elevation: Math.round(50 + fallback.dist / 2),
        duration: time,
        location,
        pattern: 'fallback-circle',
        success: true,
        warning: 'Limited pedestrian data',
        debug: LOG
      });
    }

    // GENERATE RANDOM WAYPOINTS IN PEDESTRIAN NETWORK
    LOG.push('STEP: Generating waypoints in pedestrian network');
    const waypoints = generateRandomWaypoints(lat, lng, Math.min(0.3, targetKm / 8), 4);
    LOG.push(`WAYPOINTS: ${waypoints.length}`);

    // ROUTE BETWEEN WAYPOINTS USING PEDESTRIAN GRAPH
    LOG.push('STEP: Routing via pedestrian network');
    const coordinates = [];
    let lastPoint = { lat, lng };

    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      LOG.push(`  Segment ${i + 1}: Route to WP${i + 1}`);

      const segment = dijkstraRoute(graph, lastPoint, wp);
      if (segment && segment.length > 0) {
        if (i === 0) {
          coordinates.push(...segment);
        } else {
          coordinates.push(...segment.slice(1)); // Skip duplicate start
        }
        lastPoint = wp;
        LOG.push(`    ✓ ${segment.length} points`);
      } else {
        LOG.push(`    ✗ no route found`);
      }
    }

    // Return to start
    LOG.push(`  Final: Return to center`);
    const finalSeg = dijkstraRoute(graph, lastPoint, { lat, lng });
    if (finalSeg && finalSeg.length > 0) {
      coordinates.push(...finalSeg.slice(1));
      LOG.push(`    ✓ ${finalSeg.length} points`);
    }

    if (coordinates.length < 2) {
      LOG.push('FAIL: No valid routes through graph');
      const fallback = generateFallbackCircle(lat, lng, targetKm);
      return respond(200, {
        coordinates: fallback.coords,
        distance: fallback.dist,
        elevation: Math.round(50 + fallback.dist / 2),
        duration: time,
        location,
        pattern: 'fallback-circle',
        success: true,
        warning: 'Could not route through pedestrian network',
        debug: LOG
      });
    }

    // Calculate distance
    let totalDist = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
      totalDist += haversine(coordinates[i].lat, coordinates[i].lng, coordinates[i + 1].lat, coordinates[i + 1].lng);
    }

    LOG.push(`COMPLETE: ${coordinates.length} points, ${totalDist.toFixed(2)}km`);

    return respond(200, {
      coordinates: coordinates.map(c => [c.lat, c.lng]),
      distance: parseFloat(totalDist.toFixed(2)),
      elevation: Math.round(50 + totalDist / 2),
      duration: time,
      location,
      pattern: 'pedestrian-graph',
      success: true,
      debug: LOG
    });

  } catch (err) {
    LOG.push(`CRITICAL: ${err.message}`);
    return respond(500, { error: err.message, debug: LOG });
  }
};

// ============================================================================
// RESPONSE
// ============================================================================

function respond(status, data) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data)
  };
}

// ============================================================================
// GEOCODE
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
// FETCH PEDESTRIAN WAYS ONLY
// ============================================================================

async function fetchPedestrianWays(lat, lng, radiusKm) {
  try {
    const deg = radiusKm / 111;
    
    // Query ONLY pedestrian-friendly ways
    const query = `[bbox:${lat - deg},${lng - deg},${lat + deg},${lng + deg}];
(
  way["highway"="footway"];
  way["highway"="pedestrian"];
  way["highway"="path"];
  way["highway"="track"];
  way["highway"="residential"]["sidewalk"="both"];
  way["highway"="residential"]["sidewalk"="left"];
  way["highway"="residential"]["sidewalk"="right"];
  way["highway"="unclassified"]["sidewalk"~"left|right|both"];
  way["highway"="tertiary"]["sidewalk"~"left|right|both"];
  way["leisure"="park"];
  way["leisure"="garden"];
);
out geom;`;

    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
      timeout: 20000
    });

    if (!response.ok) {
      return [];
    }

    const xml = await response.text();
    const ways = parseOverpassXML(xml);

    return ways;
  } catch (err) {
    return [];
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

      // Extract nodes with coordinates
      const ndPattern = /<nd lat="([^"]*)" lon="([^"]*)"/g;
      const nodes = [];
      let ndMatch;

      while ((ndMatch = ndPattern.exec(wayContent)) !== null) {
        nodes.push({
          lat: parseFloat(ndMatch[1]),
          lng: parseFloat(ndMatch[2])
        });
      }

      if (nodes.length >= 2) {
        ways.push({
          id: wayId,
          nodes
        });
      }
    }
  } catch (err) {}

  return ways;
}

// ============================================================================
// BUILD PEDESTRIAN GRAPH
// ============================================================================

function buildPedestrianGraph(ways, centerLat, centerLng) {
  const nodeMap = new Map();
  const edges = [];
  let nodeId = 0;

  const getOrCreateNode = (lat, lng) => {
    const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    if (!nodeMap.has(key)) {
      nodeMap.set(key, {
        id: nodeId++,
        lat,
        lng,
        edges: []
      });
    }
    return nodeMap.get(key);
  };

  // Build from ways
  for (const way of ways) {
    const wayNodes = way.nodes.map(n => getOrCreateNode(n.lat, n.lng));

    // Create bidirectional edges
    for (let i = 0; i < wayNodes.length - 1; i++) {
      const from = wayNodes[i];
      const to = wayNodes[i + 1];
      const dist = haversine(from.lat, from.lng, to.lat, to.lng);

      // Forward
      edges.push({ from: from.id, to: to.id, dist });
      from.edges.push(edges.length - 1);

      // Reverse
      edges.push({ from: to.id, to: from.id, dist });
      to.edges.push(edges.length - 1);
    }
  }

  const nodes = Array.from(nodeMap.values());
  return { nodes, edges, nodeMap };
}

// ============================================================================
// DIJKSTRA ROUTING
// ============================================================================

function dijkstraRoute(graph, start, end) {
  const { nodes, edges } = graph;
  
  // Find closest nodes to start/end
  let startNode = nodes[0];
  let endNode = nodes[0];
  let startDist = Infinity;
  let endDist = Infinity;

  for (const node of nodes) {
    const dStart = Math.abs(node.lat - start.lat) + Math.abs(node.lng - start.lng);
    const dEnd = Math.abs(node.lat - end.lat) + Math.abs(node.lng - end.lng);
    
    if (dStart < startDist) {
      startNode = node;
      startDist = dStart;
    }
    if (dEnd < endDist) {
      endNode = node;
      endDist = dEnd;
    }
  }

  if (startDist > 0.01 || endDist > 0.01) {
    // Points too far from graph
    return null;
  }

  // Dijkstra's algorithm
  const dist = new Map();
  const prev = new Map();
  const unvisited = new Set();

  for (const node of nodes) {
    dist.set(node.id, Infinity);
    unvisited.add(node.id);
  }

  dist.set(startNode.id, 0);
  const nodeById = {};
  for (const n of nodes) nodeById[n.id] = n;

  while (unvisited.size > 0) {
    let current = null;
    let minDist = Infinity;

    for (const nodeId of unvisited) {
      if (dist.get(nodeId) < minDist) {
        minDist = dist.get(nodeId);
        current = nodeId;
      }
    }

    if (current === null || current === endNode.id) break;

    unvisited.delete(current);
    const currentNode = nodeById[current];

    // Check edges from current
    for (const edgeIdx of currentNode.edges) {
      const edge = edges[edgeIdx];
      const neighbor = edge.to;

      if (!unvisited.has(neighbor)) continue;

      const alt = dist.get(current) + edge.dist;
      if (alt < dist.get(neighbor)) {
        dist.set(neighbor, alt);
        prev.set(neighbor, current);
      }
    }
  }

  // Reconstruct path
  if (!prev.has(endNode.id) && endNode.id !== startNode.id) {
    return null;
  }

  const path = [];
  let current = endNode.id;

  while (current !== undefined) {
    const node = nodeById[current];
    path.unshift({ lat: node.lat, lng: node.lng });
    current = prev.get(current);
  }

  return path.length > 1 ? path : null;
}

// ============================================================================
// RANDOM WAYPOINTS
// ============================================================================

function generateRandomWaypoints(lat, lng, radius, count) {
  const waypoints = [];
  const usedAngles = new Set();

  for (let i = 0; i < count; i++) {
    let angle;
    let attempts = 0;
    do {
      angle = Math.random() * 360;
      attempts++;
    } while (usedAngles.has(Math.round(angle / 30) * 30) && attempts < 10);

    usedAngles.add(Math.round(angle / 30) * 30);

    const rad = (angle * Math.PI) / 180;
    const radiusVariance = radius * (0.7 + Math.random() * 0.6);
    const degPerKm = 1 / 111;

    waypoints.push({
      lat: lat + radiusVariance * degPerKm * Math.sin(rad),
      lng: lng + radiusVariance * degPerKm * Math.cos(rad)
    });
  }

  waypoints.sort((a, b) => {
    const angleA = Math.atan2(a.lat - lat, a.lng - lng);
    const angleB = Math.atan2(b.lat - lat, b.lng - lng);
    return angleA - angleB;
  });

  return waypoints;
}

// ============================================================================
// FALLBACK
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

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}
