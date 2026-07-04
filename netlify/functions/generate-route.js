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

  // Overpass QL query - STRICT pedestrian ways only
  const query = `
    [bbox:${lat - radiusDegrees},${lng - radiusDegrees},${lat + radiusDegrees},${lng + radiusDegrees}];
    (
      way["highway"="footway"];
      way["highway"="path"];
      way["highway"="pedestrian"];
      way["leisure"="park"];
      way["leisure"="garden"];
      way["leisure"="pitch"];
      way["access"="public"];
    );
    out geom;
  `;

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query,
      timeout: 20000
    });

    if (!response.ok) {
      console.warn('Overpass API failed, status:', response.status);
      return [];
    }

    const data = await response.json();
    
    // Convert Overpass ways to simple format with filtering
    return (data.ways || [])
      .map(way => ({
        id: way.id,
        nodes: way.geometry.map(g => ({ lat: g.lat, lon: g.lon })),
        type: way.tags?.highway || way.tags?.leisure || 'path',
        name: way.tags?.name || null,
        access: way.tags?.access
      }))
      .filter(way => 
        way.nodes.length > 1 &&
        way.access !== 'private' &&
        way.access !== 'no'
      )
      .sort((a, b) => {
        // Prioritize footpaths
        const typeOrder = { footway: 5, path: 4, pedestrian: 4, park: 3, garden: 3, pitch: 2 };
        return (typeOrder[b.type] || 0) - (typeOrder[a.type] || 0);
      });

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
// CIRCULAR ROUTE GENERATION - IMPROVED
// ============================================================

function generateCircularRoute(graph, centerLat, centerLng, targetDistance, preferences) {
  const { nodes, edges, nodeMap } = graph;
  if (nodes.length < 3) return null;

  // Find starting node closest to center
  let startNode = nodes.reduce((best, node) => 
    node.distToCenter < best.distToCenter ? node : best
  );

  // Build adjacency with way type weights (prefer footpaths)
  const adjacency = {};
  const wayWeights = {
    'footway': 1.0,
    'path': 0.95,
    'pedestrian': 0.9,
    'residential': 0.7,
    'living_street': 0.8,
    'park': 0.9,
    'garden': 0.9
  };

  for (const node of nodes) {
    adjacency[node.id] = [];
  }

  for (const edge of edges) {
    const weight = wayWeights[edge.type] || 0.5;
    adjacency[edge.from].push({
      ...edge,
      weight
    });
  }

  // Smart circular walk using weighted graph traversal
  const route = [startNode];
  const visited = new Set([startNode.id]);
  let currentDist = 0;
  let currentNode = startNode;
  let direction = 'outward'; // outward → homeward

  const maxIterations = 300;
  let iterations = 0;
  const distThreshold = targetDistance * 0.8; // When to start returning

  while (iterations < maxIterations && currentDist < targetDistance * 1.1) {
    iterations++;

    // Get valid next edges (prefer high-weight ways, avoid backtracking)
    const validEdges = (adjacency[currentNode.id] || [])
      .filter(edge => !visited.has(edge.to))
      .sort((a, b) => b.weight - a.weight); // Prefer footpaths

    if (validEdges.length === 0) {
      // Hit dead end, try to backtrack to find unvisited paths
      const unvisitedNodes = nodes.filter(n => !visited.has(n.id));
      if (unvisitedNodes.length === 0) break;

      // Find nearest unvisited node and path to it
      const nearest = unvisitedNodes.reduce((best, n) =>
        haversine(currentNode.lat, currentNode.lon, n.lat, n.lon) <
        haversine(currentNode.lat, currentNode.lon, best.lat, best.lon)
          ? n : best
      );

      const pathToNearest = findShortestPath(currentNode.id, nearest.id, adjacency, visited);
      if (pathToNearest && pathToNearest.length > 0) {
        for (const nodeId of pathToNearest) {
          const node = nodes[nodeId];
          currentDist += haversine(currentNode.lat, currentNode.lon, node.lat, node.lon);
          visited.add(nodeId);
          route.push(node);
          currentNode = node;
        }
      } else {
        break;
      }
      continue;
    }

    // Choose next edge strategically
    let nextEdge;

    if (direction === 'outward' && currentDist < distThreshold) {
      // Move away from center, prefer high-weight ways
      nextEdge = validEdges.reduce((best, edge) => {
        const nextNode = nodes[edge.to];
        const distFromCenter = haversine(nextNode.lat, nextNode.lon, centerLat, centerLng);
        const nextDistFromCenter = haversine(
          nextNode.lat, nextNode.lon,
          centerLat, centerLng
        );
        
        // Prefer moving outward AND high-quality ways
        return (nextDistFromCenter > distFromCenter && edge.weight > (best.weight || 0))
          ? edge : best;
      });

      if (!nextEdge) {
        nextEdge = validEdges[0]; // Fallback to best way available
      }
    } else {
      // Return phase - prefer ways that go homeward
      direction = 'homeward';
      nextEdge = validEdges.reduce((best, edge) => {
        const nextNode = nodes[edge.to];
        const nextDistFromCenter = haversine(
          nextNode.lat, nextNode.lon,
          centerLat, centerLng
        );
        const currentDistFromCenter = currentNode.distToCenter;

        // Prefer getting closer to center AND high-quality ways
        return (nextDistFromCenter < currentDistFromCenter || edge.weight > (best.weight || 0))
          ? edge : best;
      });

      if (!nextEdge) {
        nextEdge = validEdges[0];
      }
    }

    // Move to next node
    const nextNode = nodes[nextEdge.to];
    const segmentDist = nextEdge.distance;
    
    currentDist += segmentDist;
    visited.add(nextNode.id);
    route.push(nextNode);
    currentNode = nextNode;
  }

  // Simplify route - reduce noise by removing nearby consecutive points
  const simplified = simplifyRoute(route);
  const coordinates = simplified.map(node => [node.lat, node.lon]);

  return {
    coordinates,
    distance: currentDist,
    nodes: route.length,
    simplified: simplified.length
  };
}

// Simple pathfinding to escape dead ends
function findShortestPath(startId, endId, adjacency, visited) {
  if (startId === endId) return [endId];

  const queue = [[startId]];
  const seen = new Set([startId]);

  while (queue.length > 0) {
    const path = queue.shift();
    const current = path[path.length - 1];

    if (current === endId) {
      return path.slice(1); // Exclude start
    }

    for (const edge of (adjacency[current] || [])) {
      if (!seen.has(edge.to) && !visited.has(edge.to)) {
        seen.add(edge.to);
        queue.push([...path, edge.to]);
      }
    }
  }

  return null;
}

// Simplify route by removing redundant points that are too close
function simplifyRoute(route) {
  if (route.length < 3) return route;

  const simplified = [route[0]];
  const minDistance = 0.0001; // ~11 meters

  for (let i = 1; i < route.length; i++) {
    const last = simplified[simplified.length - 1];
    const current = route[i];

    const dist = haversine(last.lat, last.lon, current.lat, current.lon);
    if (dist > minDistance) {
      simplified.push(current);
    }
  }

  return simplified;
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
