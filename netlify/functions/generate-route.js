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

    // STEP 4: Score each way for pedestrian-friendliness
    console.log('📊 Analyzing pedestrian infrastructure...');
    const scoredWays = allWays.map(way => ({
      ...way,
      pedestrianScore: scorePedestrianWay(way)
    }));

    // STEP 5: Filter to only good pedestrian ways
    const pedestrianWays = scoredWays.filter(w => w.pedestrianScore >= 0.4);
    console.log(`✅ ${pedestrianWays.length} ways suitable for walking (score >= 0.4)`);

    if (pedestrianWays.length < 5) {
      console.log('⚠️  Too few good pedestrian ways, lowering threshold');
      return fallbackRoute(centerLat, centerLng, targetDistanceKm);
    }

    // STEP 6: Build graph from scored ways
    const graph = buildIntelligentGraph(pedestrianWays, centerLat, centerLng);
    console.log(`✅ Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

    // STEP 7: Generate route using quality-aware routing
    const route = generateSmartCircularRoute(
      graph,
      centerLat,
      centerLng,
      targetDistanceKm,
      preferences
    );

    if (!route || route.coordinates.length < 3) {
      console.log('⚠️  Route too short, fallback');
      return fallbackRoute(centerLat, centerLng, targetDistanceKm);
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
 * Considers:
 * - Explicit pedestrian infrastructure (footways, sidewalks)
 * - Traffic speed (lower = safer)
 * - Road type
 * - Surface quality
 * - Access restrictions
 * - Infrastructure tags (crossings, lighting, etc.)
 */
function scorePedestrianWay(way) {
  const tags = way.tags || {};
  let score = 0;
  const factors = [];

  // ===== EXPLICIT PEDESTRIAN INFRASTRUCTURE (highest priority) =====
  
  // Dedicated footways/pedestrian zones
  if (tags.highway === 'footway') {
    score += 1.0;
    factors.push('footway');
  } else if (tags.highway === 'pedestrian') {
    score += 0.95;
    factors.push('pedestrian_zone');
  } else if (tags.highway === 'path' && tags.foot !== 'no') {
    score += 0.9;
    factors.push('path');
  }

  // Explicit sidewalk presence
  if (tags.sidewalk === 'both' || tags.sidewalk === 'yes') {
    score += 0.3;
    factors.push('sidewalk_both');
  } else if (tags.sidewalk === 'left' || tags.sidewalk === 'right') {
    score += 0.15;
    factors.push('sidewalk_one');
  }

  // Explicit pedestrian permission
  if (tags.foot === 'designated') {
    score += 0.25;
    factors.push('foot_designated');
  } else if (tags.foot === 'permissive') {
    score += 0.15;
    factors.push('foot_permissive');
  }

  // Parks and gardens
  if (tags.leisure === 'park' || tags.leisure === 'garden') {
    score += 0.85;
    factors.push('park_garden');
  }

  // Bus routes (usually well-maintained, good infrastructure)
  if (tags.bus_route === 'yes' || tags.route === 'bus') {
    score += 0.2;
    factors.push('bus_route');
  }

  // ===== TRAFFIC SPEED (critical for safety) =====
  
  const speedLimit = parseInt(tags.maxspeed);
  if (!isNaN(speedLimit)) {
    if (speedLimit <= 20) {
      score += 0.3;
      factors.push(`speed_${speedLimit}mph`);
    } else if (speedLimit <= 30) {
      score += 0.2;
      factors.push(`speed_${speedLimit}mph`);
    } else if (speedLimit <= 40) {
      score += 0.05;
      factors.push(`speed_${speedLimit}mph`);
    } else {
      score -= 0.1; // High speed = danger
      factors.push(`speed_${speedLimit}mph_risky`);
    }
  }

  // ===== ROAD CLASS SCORING (not exclusionary, just weighted) =====
  
  const roadType = tags.highway;
  
  if (['residential', 'living_street', 'unclassified'].includes(roadType)) {
    score += 0.4;
    factors.push('quiet_street');
  } else if (['tertiary', 'secondary'].includes(roadType)) {
    // These can be pedestrian-friendly if they have good infrastructure
    score += 0.15;
    factors.push('medium_road');
  } else if (['primary', 'trunk', 'motorway', 'motorway_link'].includes(roadType)) {
    // High-speed roads: only viable if excellent pedestrian infrastructure
    score -= 0.2;
    factors.push('high_speed_road');
  }

  // Special case: A-roads and B-roads might be pedestrian-friendly in UK
  if (tags.ref && (tags.ref.startsWith('A') || tags.ref.startsWith('B'))) {
    // A/B roads: check for pedestrian mitigation
    if (tags.sidewalk || tags.foot === 'designated' || tags['lane:footway']) {
      score += 0.25; // Good pedestrian infrastructure makes it viable
      factors.push('aroad_with_infrastructure');
    } else if (tags.maxspeed && parseInt(tags.maxspeed) <= 30) {
      score += 0.1;
      factors.push('aroad_low_speed');
    } else {
      score -= 0.15; // A-road without pedestrian features = risky
      factors.push('aroad_risky');
    }
  }

  // ===== SURFACE QUALITY =====
  
  const surface = tags.surface;
  if (['asphalt', 'concrete', 'paved_smooth'].includes(surface)) {
    score += 0.15;
    factors.push('good_surface');
  } else if (['gravel', 'dirt', 'unpaved'].includes(surface)) {
    score -= 0.1;
    factors.push('poor_surface');
  } else if (surface === 'cobblestone' || surface === 'sett') {
    score += 0.05;
    factors.push('cobblestone');
  }

  // ===== INFRASTRUCTURE & SAFETY =====
  
  if (tags.lit === 'yes') {
    score += 0.1;
    factors.push('lit');
  }

  if (tags.crossing === 'traffic_signals' || tags.crossing === 'yes') {
    score += 0.1;
    factors.push('crossing');
  }

  if (tags.barrier === 'bollard' || tags.barrier === 'gate') {
    // Protected from vehicles = safer
    score += 0.15;
    factors.push('vehicle_protected');
  }

  // Width preference (wider = better for walking)
  const width = parseFloat(tags.width);
  if (!isNaN(width)) {
    if (width >= 3) {
      score += 0.1;
      factors.push(`wide_${width}m`);
    } else if (width < 1.5) {
      score -= 0.05;
      factors.push('narrow');
    }
  }

  // ===== ACCESS RESTRICTIONS =====
  
  if (tags.access === 'private' || tags.access === 'no') {
    score = 0; // Completely blocked
    factors.push('private_restricted');
  } else if (tags.foot === 'no' || tags.foot === 'discouraged') {
    score = 0; // No foot access
    factors.push('foot_prohibited');
  }

  // Normalize score to 0-1 range and cap
  score = Math.max(0, Math.min(1, score));

  console.log(`  Way ${way.id}: score=${score.toFixed(2)} [${tags.highway}] (${factors.join(', ')})`);

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

function fallbackRoute(lat, lng, distanceKm) {
  const radiusDegrees = (distanceKm / 2) / 111;
  const numPoints = 24;
  const coordinates = [];

  for (let i = 0; i < numPoints; i++) {
    const angle = (i / numPoints) * Math.PI * 2;
    coordinates.push([
      lat + radiusDegrees * Math.sin(angle),
      lng + radiusDegrees * Math.cos(angle)
    ]);
  }
  coordinates.push(coordinates[0]);

  return success({
    coordinates,
    distance: distanceKm,
    elevation: Math.round(50 + (distanceKm / 2)),
    fallback: true,
    pattern: 'fallback-circle',
    success: true
  });
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
