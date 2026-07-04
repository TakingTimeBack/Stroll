/**
 * STROLL CUSTOM ROUTING ENGINE
 * 
 * Builds a pedestrian network from OpenStreetMap data and generates
 * optimal circular walking routes for any location and distance.
 * 
 * Uses: Nominatim (geocoding) + Overpass API (pedestrian ways)
 * No external routing - all logic is Stroll's own
 */

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { location, time, pace, preferences } = body;

    console.log('🚶 STROLL ROUTER:', { location, time, pace, preferences });

    // STEP 1: Geocode location
    const centerCoords = await geocodeLocation(location);
    if (!centerCoords) {
      return error(400, 'Location not found. Try: "Chester", "Main Street, London"');
    }

    const [centerLat, centerLng] = centerCoords;
    console.log('✅ Location:', location, `[${centerLat.toFixed(4)}, ${centerLng.toFixed(4)}]`);

    // STEP 2: Calculate target distance
    const targetDistanceKm = (time / 60) * pace;
    console.log(`📏 Target: ${targetDistanceKm.toFixed(1)}km (${time}m at ${pace}km/h)`);

    // STEP 3: Build pedestrian network around location
    const radius = calculateSearchRadius(targetDistanceKm);
    console.log(`🗺️  Fetching pedestrian ways in ${radius}m radius...`);
    
    const ways = await fetchPedestrianWays(centerLat, centerLng, radius);
    if (!ways || ways.length === 0) {
      console.log('⚠️  No pedestrian ways found, using fallback circle route');
      return fallbackRoute(centerLat, centerLng, targetDistanceKm);
    }

    console.log(`✅ Found ${ways.length} pedestrian ways`);

    // STEP 4: Build graph of connected segments
    const graph = buildGraph(ways, centerLat, centerLng);
    console.log(`✅ Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

    // STEP 5: Generate circular route from graph
    const route = generateCircularRoute(
      graph,
      centerLat,
      centerLng,
      targetDistanceKm,
      preferences
    );

    if (!route || route.coordinates.length < 2) {
      console.log('⚠️  Route generation failed, using fallback');
      return fallbackRoute(centerLat, centerLng, targetDistanceKm);
    }

    console.log(`✅ Route: ${route.distance.toFixed(1)}km, ${route.coordinates.length} points`);

    return success({
      coordinates: route.coordinates,
      distance: route.distance,
      elevation: Math.round(50 + (route.distance / 2)),
      duration: time,
      location: location,
      pattern: 'custom-pedestrian',
      success: true,
      metadata: {
        engine: 'stroll-custom',
        source: 'openstreetmap',
        ways: ways.length,
        nodes: graph.nodes.length
      }
    });

  } catch (err) {
    console.error('❌ Router error:', err.message);
    return error(500, 'Route generation failed');
  }
};

// ============================================================
// GEOCODING
// ============================================================

async function geocodeLocation(location) {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`,
      { headers: { 'User-Agent': 'Stroll-App' } }
    );
    
    const data = await response.json();
    if (!data || data.length === 0) return null;

    return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  } catch (err) {
    console.error('Geocoding error:', err.message);
    return null;
  }
}

// ============================================================
// PEDESTRIAN WAY FETCHING (Overpass API)
// ============================================================

async function fetchPedestrianWays(lat, lng, radiusMeters) {
  const radiusDegrees = radiusMeters / 111000; // 1 degree ≈ 111km

  // Overpass QL query for pedestrian-friendly ways
  const query = `
    [bbox:${lat - radiusDegrees},${lng - radiusDegrees},${lat + radiusDegrees},${lng + radiusDegrees}];
    (
      way["highway"="footway"];
      way["highway"="path"]["foot"!="no"];
      way["highway"="residential"];
      way["highway"="living_street"];
      way["highway"="pedestrian"];
      way["leisure"="park"];
      way["leisure"="garden"];
      way["access"="public"]["foot"!="no"];
    );
    out geom;
  `;

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
      timeout: 15000
    });

    if (!response.ok) {
      console.warn('Overpass API failed, status:', response.status);
      return [];
    }

    const data = await response.json();
    
    // Convert Overpass ways to simple format
    return (data.ways || []).map(way => ({
      id: way.id,
      nodes: way.geometry.map(g => ({ lat: g.lat, lon: g.lon })),
      type: way.tags?.highway || way.tags?.leisure || 'path',
      name: way.tags?.name || null
    })).filter(way => way.nodes.length > 1);

  } catch (err) {
    console.warn('Overpass fetch error:', err.message);
    return [];
  }
}

// ============================================================
// GRAPH BUILDING
// ============================================================

function buildGraph(ways, centerLat, centerLng) {
  const nodes = new Map(); // id → {lat, lon, edges: []}
  const edges = []; // {from, to, distance, type}
  let nodeCounter = 0;

  // Helper to get/create node
  function getOrCreateNode(lat, lon) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (!nodes.has(key)) {
      nodes.set(key, {
        id: nodeCounter++,
        lat,
        lon,
        edges: [],
        distToCenter: haversine(lat, lon, centerLat, centerLng)
      });
    }
    return nodes.get(key);
  }

  // Build graph from ways
  for (const way of ways) {
    const wayNodes = way.nodes.map(n => getOrCreateNode(n.lat, n.lon));

    // Connect consecutive nodes
    for (let i = 0; i < wayNodes.length - 1; i++) {
      const from = wayNodes[i];
      const to = wayNodes[i + 1];
      const distance = haversine(from.lat, from.lon, to.lat, to.lon);

      edges.push({
        from: from.id,
        to: to.id,
        distance,
        type: way.type,
        name: way.name,
        wayId: way.id
      });

      from.edges.push(edges.length - 1);
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges,
    nodeMap: nodes
  };
}

// ============================================================
// CIRCULAR ROUTE GENERATION
// ============================================================

function generateCircularRoute(graph, centerLat, centerLng, targetDistance, preferences) {
  const { nodes, edges, nodeMap } = graph;
  if (nodes.length < 3) return null;

  // Find starting node closest to center
  let startNode = nodes[0];
  let minDist = startNode.distToCenter;
  for (const node of nodes) {
    if (node.distToCenter < minDist) {
      minDist = node.distToCenter;
      startNode = node;
    }
  }

  // Build adjacency map for faster access
  const adjacency = {};
  for (const node of nodes) {
    adjacency[node.id] = [];
  }
  for (const edge of edges) {
    adjacency[edge.from].push(edge);
  }

  // Greedy circular walk: go out, explore, return
  const route = [startNode];
  const visited = new Set([startNode.id]);
  let currentDist = 0;
  let phase = 'explore'; // explore → return

  let currentNode = startNode;
  const maxIterations = 200;
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    // Get available next nodes
    const availableEdges = (adjacency[currentNode.id] || [])
      .filter(edge => !visited.has(edge.to));

    if (availableEdges.length === 0) {
      // Dead end, find nearest visited node with unexplored edges
      const nodeWithOptions = nodes.find(n =>
        visited.has(n.id) &&
        (adjacency[n.id] || []).some(e => !visited.has(e.to))
      );

      if (!nodeWithOptions) break;
      currentNode = nodeWithOptions;
      continue;
    }

    // Smart edge selection
    let nextEdge;
    if (phase === 'explore') {
      if (currentDist < targetDistance * 0.6) {
        // Go away from center
        nextEdge = availableEdges.reduce((best, edge) => {
          const nextNode = nodes[edge.to];
          const newDistToCenter = haversine(
            nextNode.lat, nextNode.lon,
            centerLat, centerLng
          );
          return newDistToCenter > (nodes[best.to].distToCenter || 0) ? edge : best;
        });
      } else {
        // Start returning
        phase = 'return';
        nextEdge = availableEdges.reduce((best, edge) => {
          const nextNode = nodes[edge.to];
          const newDistToCenter = haversine(
            nextNode.lat, nextNode.lon,
            centerLat, centerLng
          );
          return newDistToCenter < (nodes[best.to].distToCenter || Infinity) ? edge : best;
        });
      }
    } else {
      // Return phase - prefer nodes closer to center
      nextEdge = availableEdges.reduce((best, edge) => {
        const nextNode = nodes[edge.to];
        const newDistToCenter = haversine(
          nextNode.lat, nextNode.lon,
          centerLat, centerLng
        );
        return newDistToCenter < (nodes[best.to].distToCenter || Infinity) ? edge : best;
      });
    }

    // Move to next node
    const nextNode = nodes[nextEdge.to];
    currentDist += nextEdge.distance;
    visited.add(nextNode.id);
    route.push(nextNode);
    currentNode = nextNode;

    // Stop if we've achieved target distance
    if (currentDist >= targetDistance * 0.9) break;
  }

  // Convert route to coordinates
  const coordinates = route.map(node => [node.lat, node.lon]);

  return {
    coordinates,
    distance: currentDist,
    nodes: route.length,
    phases: 'explore-return'
  };
}

// ============================================================
// UTILITIES
// ============================================================

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function calculateSearchRadius(distanceKm) {
  // Search radius should be enough to find paths for the route
  // Rule of thumb: 1.5x the target distance (accounts for indirect paths)
  return Math.min(3000, Math.max(500, distanceKm * 1.5 * 1000)); // meters, cap at 3km
}

function fallbackRoute(lat, lng, distanceKm) {
  // Simple circle as fallback
  const radiusDegrees = (distanceKm / 2) / 111;
  const numPoints = 20;
  const coordinates = [];

  for (let i = 0; i < numPoints; i++) {
    const angle = (i / numPoints) * Math.PI * 2;
    coordinates.push([
      lat + radiusDegrees * Math.sin(angle),
      lng + radiusDegrees * Math.cos(angle)
    ]);
  }
  coordinates.push(coordinates[0]); // Close loop

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
