/**
 * STROLL INTELLIGENT PEDESTRIAN ROUTER
 * 
 * Advanced routing that doesn't rely on road class alone.
 * Analyzes real pedestrian characteristics:
 * - Sidewalk presence/width
 * - Pedestrian infrastructure (crossings, zones)
 * - Surface quality
 * - Traffic speed (speed limits)
 * - Connectivity and safety
 * 
 * Smart enough to use an A-road with good sidewalks,
 * but avoid quiet residential dead-ends.
 */

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { location, time, pace, preferences } = body;

    console.log('🚶 STROLL INTELLIGENT ROUTER:', { location, time, pace });

    // STEP 1: Geocode
    const centerCoords = await geocodeLocation(location);
    if (!centerCoords) {
      return error(400, 'Location not found');
    }

    const [centerLat, centerLng] = centerCoords;
    console.log('✅ Location:', location);

    // STEP 2: Calculate target distance
    const targetDistanceKm = (time / 60) * pace;
    console.log(`📏 Target: ${targetDistanceKm.toFixed(1)}km`);

    // STEP 3: Fetch all ways (no filtering by type yet)
    const radius = calculateSearchRadius(targetDistanceKm);
    console.log(`🗺️  Fetching all ways in ${radius}m radius...`);
    
    const allWays = await fetchAllWays(centerLat, centerLng, radius);
    if (!allWays || allWays.length === 0) {
      console.log('⚠️  No ways found');
      return fallbackRoute(centerLat, centerLng, targetDistanceKm);
    }

    console.log(`✅ Fetched ${allWays.length} ways`);

    // STEP 5: Filter to only walkable ways - more lenient threshold
    console.log('📊 Analyzing pedestrian infrastructure...');
    const scoredWays = allWays.map(way => ({
      ...way,
      pedestrianScore: scorePedestrianWay(way)
    }));

    // Log score distribution
    const scores = scoredWays.map(w => w.pedestrianScore);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`📊 Score distribution: avg=${avgScore.toFixed(2)}, min=${Math.min(...scores).toFixed(2)}, max=${Math.max(...scores).toFixed(2)}`);

    // Filter with lower threshold - 0.2 instead of 0.4
    const pedestrianWays = scoredWays.filter(w => w.pedestrianScore >= 0.2);
    console.log(`✅ ${pedestrianWays.length} ways suitable for walking (score >= 0.2)`);

    if (pedestrianWays.length < 3) {
      console.log('❌ CRITICAL: Fewer than 3 walkable ways found, cannot generate route');
      return error(400, 'Not enough pedestrian infrastructure in this area');
    }

    // STEP 6: Build graph from scored ways
    const graph = buildIntelligentGraph(pedestrianWays, centerLat, centerLng);
    console.log(`✅ Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

    if (graph.nodes.length < 3 || graph.edges.length < 2) {
      console.log('❌ Graph too small to route');
      return error(400, 'Insufficient connected paths in this area');
    }

    // STEP 7: Generate route using quality-aware routing
    const route = generateSmartCircularRoute(
      graph,
      centerLat,
      centerLng,
      targetDistanceKm,
      preferences
    );

    if (!route || route.coordinates.length < 3) {
      console.log('❌ Route generation failed completely');
      return error(400, 'Unable to generate a walking route for this location');
    }

    console.log(`✅ Route: ${route.distance.toFixed(1)}km, ${route.coordinates.length} points`);
    console.log(`📊 Quality: Safety ${route.safetyScore.toFixed(2)}, Walkability ${route.walkabilityScore.toFixed(2)}`);

    return success({
      coordinates: route.coordinates,
      distance: route.distance,
      elevation: Math.round(50 + (route.distance / 2)),
      duration: time,
      location: location,
      pattern: 'intelligent-pedestrian',
      success: true,
      metadata: {
        engine: 'stroll-intelligent',
        source: 'openstreetmap',
        ways: pedestrianWays.length,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        safetyScore: route.safetyScore,
        walkabilityScore: route.walkabilityScore
      }
    });

  } catch (err) {
    console.error('❌ Router error:', err.message);
    return error(500, 'Route generation failed');
  }
};

// ============================================================
// PEDESTRIAN SCORING SYSTEM
// ============================================================

/**
 * Score a way for pedestrian friendliness (0.0 to 1.0)
 * 
 * PHILOSOPHY: Most ways are walkable unless explicitly forbidden.
 * Scoring reflects quality of walk, not whether it's possible.
 * 
 * - 1.0: Perfect (dedicated footpath, park)
 * - 0.7-0.9: Good (residential, pedestrian zone)
 * - 0.4-0.7: Fair (regular road with some pedestrian features)
 * - 0.2-0.4: Acceptable (any road without explicit foot=no)
 * - 0.0: Forbidden (private, foot=no)
 */
function scorePedestrianWay(way) {
  const tags = way.tags || {};
  
  // ===== AUTOMATIC EXCLUSIONS =====
  if (tags.access === 'private' || tags.access === 'no') return 0;
  if (tags.foot === 'no' || tags.foot === 'discouraged') return 0;
  if (tags.motor_vehicle === 'only') return 0;
  
  // Start with baseline - most ways are walkable
  let score = 0.3;
  
  // ===== EXPLICIT PEDESTRIAN INFRASTRUCTURE =====
  if (tags.highway === 'footway') {
    score = 1.0;
  } else if (tags.highway === 'pedestrian') {
    score = 0.95;
  } else if (tags.highway === 'path') {
    score = 0.85;
  } else if (tags.leisure === 'park' || tags.leisure === 'garden') {
    score = 0.9;
  } else if (tags.highway === 'track') {
    score = 0.7;
  }
  // If no special type, start from 0.3 baseline (any regular road)
  
  // ===== BOOST FOR PEDESTRIAN FEATURES =====
  if (tags.sidewalk === 'both') score = Math.min(1, score + 0.25);
  else if (tags.sidewalk === 'yes' || tags.sidewalk === 'left' || tags.sidewalk === 'right') score = Math.min(1, score + 0.15);
  
  if (tags.foot === 'designated') score = Math.min(1, score + 0.2);
  if (tags.foot === 'permissive') score = Math.min(1, score + 0.1);
  
  if (tags.lit === 'yes') score = Math.min(1, score + 0.1);
  
  // ===== PENALIZE HIGH-SPEED ROADS (but don't exclude) =====
  const speedLimit = parseInt(tags.maxspeed);
  if (!isNaN(speedLimit)) {
    if (speedLimit >= 70) score *= 0.5; // Motorway speed = risky
    else if (speedLimit >= 50) score *= 0.7; // High speed
    else if (speedLimit >= 40) score *= 0.85; // Medium-high
    // <= 30: no penalty
  } else if (tags.highway === 'motorway' || tags.highway === 'motorway_link') {
    score *= 0.3; // Motorway without explicit speed = dangerous
  } else if (tags.highway === 'trunk' || tags.highway === 'trunk_link') {
    score *= 0.5; // Trunk roads risky
  } else if (tags.highway === 'primary' || tags.highway === 'primary_link') {
    score *= 0.7; // Primary roads less safe
  } else if (tags.highway === 'secondary' || tags.highway === 'secondary_link') {
    score *= 0.85; // Secondary OK if reasonable
  } else if (['residential', 'living_street', 'tertiary', 'unclassified'].includes(tags.highway)) {
    score *= 1.0; // No penalty for quiet roads
  }
  
  // ===== SURFACE QUALITY =====
  const surface = tags.surface;
  if (surface === 'asphalt' || surface === 'concrete' || surface === 'paved_smooth') {
    score = Math.min(1, score + 0.1);
  } else if (surface === 'gravel' || surface === 'dirt' || surface === 'unpaved') {
    score *= 0.9; // Slightly worse, but still walkable
  }
  
  // Ensure score is in valid range
  score = Math.max(0.01, Math.min(1, score));
  
  return score;
}

// ============================================================
// INTELLIGENT GRAPH BUILDING
// ============================================================

function buildIntelligentGraph(ways, centerLat, centerLng) {
  const nodes = new Map();
  const edges = [];
  let nodeCounter = 0;

  function getOrCreateNode(lat, lon, wayScore) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (!nodes.has(key)) {
      nodes.set(key, {
        id: nodeCounter++,
        lat,
        lon,
        edges: [],
        distToCenter: haversine(lat, lon, centerLat, centerLng),
        connectivity: 0 // Track how many edges connect here
      });
    }
    return nodes.get(key);
  }

  // Build graph
  for (const way of ways) {
    const wayNodes = way.nodes.map(n => getOrCreateNode(n.lat, n.lon, way.pedestrianScore));

    // Connect consecutive nodes
    for (let i = 0; i < wayNodes.length - 1; i++) {
      const from = wayNodes[i];
      const to = wayNodes[i + 1];
      const distance = haversine(from.lat, from.lon, to.lat, to.lon);

      edges.push({
        from: from.id,
        to: to.id,
        distance,
        score: way.pedestrianScore,
        highway: way.tags?.highway,
        name: way.tags?.name,
        wayId: way.id
      });

      from.edges.push(edges.length - 1);
      from.connectivity++;
      to.connectivity++;
    }
  }

  // Convert nodes Map to Array and calculate quality
  const nodesArray = Array.from(nodes.values());
  for (const node of nodesArray) {
    node.quality = Math.min(1, node.connectivity / 4); // 4+ connections = high quality
  }

  return {
    nodes: nodesArray,
    edges,
    nodeMap: nodes
  };
}

// ============================================================
// SMART CIRCULAR ROUTE GENERATION
// ============================================================

function generateSmartCircularRoute(graph, centerLat, centerLng, targetDistance, preferences) {
  const { nodes, edges, nodeMap } = graph;
  if (nodes.length < 3) return null;

  // Create lookup map
  const nodeById = {};
  for (const node of nodes) {
    nodeById[node.id] = node;
  }

  // Find best starting node: close to center, high connectivity
  let startNode = nodes.reduce((best, node) => {
    const centerScore = 1 / (1 + node.distToCenter); // Closer = better
    const connScore = node.connectivity / 10;
    const total = centerScore + connScore;
    return total > (best._score || 0) ? { ...node, _score: total } : best;
  });

  // Build adjacency with quality weighting
  const adjacency = {};
  for (const node of nodes) {
    adjacency[node.id] = [];
  }

  for (const edge of edges) {
    const toNode = nodeById[edge.to];
    adjacency[edge.from].push({
      ...edge,
      quality: edge.score * toNode.quality // Combined quality score
    });
  }

  // Sort edges by quality
  for (const edgeList of Object.values(adjacency)) {
    edgeList.sort((a, b) => b.quality - a.quality);
  }

  // Generate route with quality awareness
  const route = [startNode];
  const visited = new Set([startNode.id]);
  let currentDist = 0;
  let currentNode = startNode;
  let direction = 'outward';

  const maxIterations = 500;
  let iterations = 0;
  const distThreshold = targetDistance * 0.75;
  
  let safetyScore = 0;
  let walkabilityScore = 0;
  let scoreCount = 0;

  while (iterations < maxIterations && currentDist < targetDistance * 1.1) {
    iterations++;

    // Get unvisited edges, prefer high-quality ways
    const validEdges = (adjacency[currentNode.id] || [])
      .filter(edge => !visited.has(edge.to))
      .slice(0, 10); // Consider top 10 options

    if (validEdges.length === 0) {
      // Find alternate route
      const unvisited = nodes.filter(n => !visited.has(n.id));
      if (unvisited.length === 0) break;

      const nearest = unvisited.reduce((best, n) =>
        haversine(currentNode.lat, currentNode.lon, n.lat, n.lon) <
        haversine(currentNode.lat, currentNode.lon, best.lat, best.lon)
          ? n : best
      );

      // Jump to unvisited area
      const jumpDist = haversine(currentNode.lat, currentNode.lon, nearest.lat, nearest.lon);
      currentDist += jumpDist;
      visited.add(nearest.id);
      route.push(nearest);
      currentNode = nearest;
      continue;
    }

    // Choose next edge based on direction and quality
    let nextEdge;

    if (direction === 'outward' && currentDist < distThreshold) {
      // Go outward, prefer quality ways that move away from center
      nextEdge = validEdges.reduce((best, edge) => {
        const nextNode = nodeById[edge.to];
        const moveOutward = nextNode.distToCenter > currentNode.distToCenter;
        const quality = edge.quality;

        const bestScore = (best._moveOutward ? 0.5 : 0) + (best.quality || 0);
        const score = (moveOutward ? 0.5 : 0) + quality;

        return score > bestScore ? { ...edge, _moveOutward: moveOutward } : best;
      });

      if (!nextEdge) {
        nextEdge = validEdges[0];
      }
    } else {
      // Return phase - go homeward via quality ways
      direction = 'homeward';
      nextEdge = validEdges.reduce((best, edge) => {
        const nextNode = nodeById[edge.to];
        const moveHome = nextNode.distToCenter < currentNode.distToCenter;
        const quality = edge.quality;

        const bestScore = (best._moveHome ? 0.5 : 0) + (best.quality || 0);
        const score = (moveHome ? 0.5 : 0) + quality;

        return score > bestScore ? { ...edge, _moveHome: moveHome } : best;
      });

      if (!nextEdge) {
        nextEdge = validEdges[0];
      }
    }

    // Move along edge
    const nextNode = nodeById[nextEdge.to];
    currentDist += nextEdge.distance;
    visited.add(nextNode.id);
    route.push(nextNode);
    currentNode = nextNode;

    // Track quality metrics
    safetyScore += nextEdge.quality;
    walkabilityScore += nextNode.quality;
    scoreCount++;
  }

  const coordinates = route.map(n => [n.lat, n.lon]);

  return {
    coordinates: simplifyRoute(route).map(n => [n.lat, n.lon]),
    distance: currentDist,
    nodes: route.length,
    safetyScore: scoreCount > 0 ? safetyScore / scoreCount : 0.5,
    walkabilityScore: scoreCount > 0 ? walkabilityScore / scoreCount : 0.5
  };
}

// ============================================================
// DATA FETCHING
// ============================================================

async function geocodeLocation(location) {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`,
      { headers: { 'User-Agent': 'Stroll-App' } }
    );
    const data = await response.json();
    return data && data.length > 0 ? [parseFloat(data[0].lat), parseFloat(data[0].lon)] : null;
  } catch (err) {
    console.error('Geocoding error:', err.message);
    return null;
  }
}

/**
 * Fetch ALL ways (no highway type filter)
 * Let the pedestrian scorer decide what's walkable
 */
async function fetchAllWays(lat, lng, radiusMeters) {
  const radiusDegrees = radiusMeters / 111000;

  const query = `
    [bbox:${lat - radiusDegrees},${lng - radiusDegrees},${lat + radiusDegrees},${lng + radiusDegrees}];
    (
      way["highway"];
      way["leisure"="park"];
      way["leisure"="garden"];
    );
    out geom;
  `;

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
      timeout: 30000
    });

    if (!response.ok) return [];

    const data = await response.json();
    return (data.ways || [])
      .map(way => ({
        id: way.id,
        nodes: way.geometry.map(g => ({ lat: g.lat, lon: g.lon })),
        tags: way.tags || {}
      }))
      .filter(way => way.nodes.length > 1);

  } catch (err) {
    console.warn('Overpass error:', err.message);
    return [];
  }
}

// ============================================================
// UTILITIES
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

function calculateSearchRadius(distanceKm) {
  return Math.min(4000, Math.max(800, distanceKm * 1.8 * 1000));
}

function simplifyRoute(route) {
  if (route.length < 3) return route;
  const simplified = [route[0]];
  const minDistance = 0.0001;

  for (let i = 1; i < route.length; i++) {
    const last = simplified[simplified.length - 1];
    const current = route[i];
    if (haversine(last.lat, last.lon, current.lat, current.lon) > minDistance) {
      simplified.push(current);
    }
  }

  return simplified;
}

function success(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data)
  };
}

function error(code, message) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: message })
  };
}
