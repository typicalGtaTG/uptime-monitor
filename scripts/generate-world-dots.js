const fs = require('fs');
const path = require('path');
const { feature } = require('topojson-client');

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 500;
const DOT_STEP = 11;

function projectToLonLat(x, y) {
    const lon = (x / VIEW_WIDTH) * 360 - 180;
    const lat = 90 - (y / VIEW_HEIGHT) * 180;
    return [lon, lat];
}

function pointInRing(point, ring) {
    const [x, y] = point;
    let inside = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];

        const intersects = ((yi > y) !== (yj > y))
            && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);

        if (intersects) inside = !inside;
    }

    return inside;
}

function pointInPolygon(point, polygonRings) {
    if (!polygonRings || polygonRings.length === 0) return false;
    if (!pointInRing(point, polygonRings[0])) return false;

    for (let i = 1; i < polygonRings.length; i += 1) {
        if (pointInRing(point, polygonRings[i])) return false;
    }

    return true;
}

function pointInMultiPolygon(point, multiPolygonCoords) {
    for (const polygon of multiPolygonCoords) {
        if (pointInPolygon(point, polygon)) return true;
    }
    return false;
}

function extractMultiPolygonCoordinates(geoJson) {
    if (!geoJson) return [];

    if (geoJson.type === 'FeatureCollection') {
        return geoJson.features.flatMap(featureItem => extractMultiPolygonCoordinates(featureItem));
    }

    if (geoJson.type === 'Feature') {
        return extractMultiPolygonCoordinates(geoJson.geometry);
    }

    if (geoJson.type === 'Polygon') {
        return [geoJson.coordinates];
    }

    if (geoJson.type === 'MultiPolygon') {
        return geoJson.coordinates;
    }

    if (geoJson.type === 'GeometryCollection') {
        return geoJson.geometries.flatMap(geometry => extractMultiPolygonCoordinates(geometry));
    }

    return [];
}

async function run() {
    const response = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json');
    if (!response.ok) {
        throw new Error(`Failed to fetch topology: HTTP ${response.status}`);
    }

    const topology = await response.json();
    const landFeature = feature(topology, topology.objects.land);
    const multiPolygonCoords = extractMultiPolygonCoordinates(landFeature);

    if (!multiPolygonCoords.length) {
        throw new Error('No polygon coordinates were extracted from topology.');
    }

    const dots = [];

    for (let y = 8; y < VIEW_HEIGHT - 8; y += DOT_STEP) {
        for (let x = 8; x < VIEW_WIDTH - 8; x += DOT_STEP) {
            const lonLatPoint = projectToLonLat(x, y);
            if (pointInMultiPolygon(lonLatPoint, multiPolygonCoords)) {
                dots.push({ x, y });
            }
        }
    }

    const outputDirectory = path.join(process.cwd(), 'public', 'data');
    fs.mkdirSync(outputDirectory, { recursive: true });

    const outputPath = path.join(outputDirectory, 'world-dots-1000x500-step11.json');
    const payload = {
        width: VIEW_WIDTH,
        height: VIEW_HEIGHT,
        step: DOT_STEP,
        dots
    };

    fs.writeFileSync(outputPath, JSON.stringify(payload));
    console.log(`Generated ${dots.length} dots at ${outputPath}`);
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
