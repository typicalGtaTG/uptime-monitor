const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 500;
const DOT_STEP = 11;
const DOT_RADIUS = 1.9;

const mapInstances = new WeakMap();
let landDotsPromise = null;

function projectLatLon(lat, lon) {
    const safeLat = Number.isFinite(Number(lat)) ? Number(lat) : 0;
    const safeLon = Number.isFinite(Number(lon)) ? Number(lon) : 0;

    const x = ((safeLon + 180) / 360) * VIEW_WIDTH;
    const y = ((90 - safeLat) / 180) * VIEW_HEIGHT;

    return {
        x: Math.max(0, Math.min(VIEW_WIDTH, x)),
        y: Math.max(0, Math.min(VIEW_HEIGHT, y))
    };
}

function drawPolygonPath(ctx, polygonCoordinates) {
    if (!Array.isArray(polygonCoordinates)) return;

    polygonCoordinates.forEach(ring => {
        if (!Array.isArray(ring) || ring.length === 0) return;

        ring.forEach((coordinate, index) => {
            const [lon, lat] = coordinate;
            const projected = projectLatLon(lat, lon);
            if (index === 0) {
                ctx.moveTo(projected.x, projected.y);
            } else {
                ctx.lineTo(projected.x, projected.y);
            }
        });

        ctx.closePath();
    });
}

function extractMultiPolygonCoordinates(geoJson) {
    if (!geoJson) return [];

    if (geoJson.type === 'FeatureCollection') {
        return geoJson.features.flatMap(item => extractMultiPolygonCoordinates(item));
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

async function buildLandDots() {
    const topologyResponse = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json');
    if (!topologyResponse.ok) {
        throw new Error('Failed to fetch world map topology.');
    }

    const topology = await topologyResponse.json();
    const topojsonClient = await import('https://cdn.jsdelivr.net/npm/topojson-client@3/+esm');
    const landFeature = topojsonClient.feature(topology, topology.objects.land);
    const multiPolygonCoordinates = extractMultiPolygonCoordinates(landFeature);
    if (!multiPolygonCoordinates.length) {
        throw new Error('Could not extract land polygons from topology.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = VIEW_WIDTH;
    canvas.height = VIEW_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Could not initialize map raster context.');
    }

    context.beginPath();

    multiPolygonCoordinates.forEach(polygon => drawPolygonPath(context, polygon));

    context.fillStyle = '#ffffff';
    context.fill();

    const dots = [];
    const pixels = context.getImageData(0, 0, VIEW_WIDTH, VIEW_HEIGHT).data;

    for (let y = 8; y < VIEW_HEIGHT - 8; y += DOT_STEP) {
        for (let x = 8; x < VIEW_WIDTH - 8; x += DOT_STEP) {
            const pixelIndex = ((Math.floor(y) * VIEW_WIDTH) + Math.floor(x)) * 4;
            const alpha = pixels[pixelIndex + 3];
            if (alpha > 10) {
                dots.push({ x, y });
            }
        }
    }

    if (dots.length < 300) {
        throw new Error('World topology produced too few land dots.');
    }

    return dots;
}

function buildFallbackContinentDots() {
    const blobs = [
        { cx: 215, cy: 145, rx: 145, ry: 95 },
        { cx: 265, cy: 285, rx: 70, ry: 115 },
        { cx: 500, cy: 155, rx: 85, ry: 70 },
        { cx: 560, cy: 155, rx: 210, ry: 90 },
        { cx: 545, cy: 255, rx: 95, ry: 120 },
        { cx: 805, cy: 320, rx: 85, ry: 60 },
        { cx: 615, cy: 320, rx: 38, ry: 32 },
        { cx: 365, cy: 90, rx: 55, ry: 38 }
    ];

    const dots = [];
    for (let y = 8; y < VIEW_HEIGHT - 8; y += DOT_STEP) {
        for (let x = 8; x < VIEW_WIDTH - 8; x += DOT_STEP) {
            const inside = blobs.some(blob => {
                const dx = (x - blob.cx) / blob.rx;
                const dy = (y - blob.cy) / blob.ry;
                return (dx * dx) + (dy * dy) <= 1;
            });

            if (inside) {
                dots.push({ x, y });
            }
        }
    }

    return dots;
}

async function getLandDots() {
    if (!landDotsPromise) {
        landDotsPromise = fetch('/data/world-dots-1000x500-step11.json')
            .then(async response => {
                if (!response.ok) throw new Error(`World dot data unavailable: HTTP ${response.status}`);
                const payload = await response.json();
                if (!Array.isArray(payload?.dots) || payload.dots.length < 500) {
                    throw new Error('World dot data is invalid.');
                }
                return payload.dots;
            })
            .catch(() => buildLandDots())
            .catch(() => buildFallbackContinentDots());
    }

    return landDotsPromise;
}

function createSvgElement(tagName, attributes = {}) {
    const element = document.createElementNS(SVG_NS, tagName);
    Object.entries(attributes).forEach(([key, value]) => {
        element.setAttribute(key, String(value));
    });
    return element;
}

function createMapSkeleton(container, dots) {
    container.innerHTML = '';
    container.classList.add('world-dot-map-host');

    const svg = createSvgElement('svg', {
        class: 'world-dot-map-svg',
        viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
        preserveAspectRatio: 'xMidYMid meet',
        role: 'img',
        'aria-label': 'World map'
    });

    const defs = createSvgElement('defs');
    const glow = createSvgElement('filter', {
        id: 'world-dot-glow',
        x: '-50%',
        y: '-50%',
        width: '200%',
        height: '200%'
    });
    glow.appendChild(createSvgElement('feGaussianBlur', {
        stdDeviation: 0.8,
        result: 'blur'
    }));
    defs.appendChild(glow);
    svg.appendChild(defs);

    const backdrop = createSvgElement('rect', {
        x: 0,
        y: 0,
        width: VIEW_WIDTH,
        height: VIEW_HEIGHT,
        class: 'world-dot-backdrop'
    });
    svg.appendChild(backdrop);

    const landLayer = createSvgElement('g', { class: 'world-dot-land-layer' });
    dots.forEach(dot => {
        landLayer.appendChild(createSvgElement('circle', {
            cx: dot.x,
            cy: dot.y,
            r: DOT_RADIUS,
            class: 'world-dot-land-dot'
        }));
    });

    const markerLayer = createSvgElement('g', { class: 'world-dot-marker-layer' });

    svg.appendChild(landLayer);
    svg.appendChild(markerLayer);
    container.appendChild(svg);

    return { svg, markerLayer };
}

function setMapPoints(markerLayer, points, handlers = {}) {
    markerLayer.innerHTML = '';

    points.forEach(point => {
        const projected = projectLatLon(point.lat, point.lon);
        const color = point.color || '#2de2e6';

        const group = createSvgElement('g', { class: 'world-dot-marker-group' });

        const pulse = createSvgElement('circle', {
            cx: projected.x,
            cy: projected.y,
            r: 9,
            class: 'world-dot-marker-pulse',
            stroke: color
        });
        const core = createSvgElement('circle', {
            cx: projected.x,
            cy: projected.y,
            r: 4.8,
            class: 'world-dot-marker-core',
            fill: color
        });

        const title = createSvgElement('title');
        title.textContent = point.label || 'Location marker';

        group.appendChild(pulse);
        group.appendChild(core);
        group.appendChild(title);

        if (typeof handlers.onHover === 'function') {
            group.addEventListener('mouseenter', () => handlers.onHover(point));
            group.addEventListener('focus', () => handlers.onHover(point));
        }

        if (typeof handlers.onClick === 'function') {
            group.addEventListener('click', () => handlers.onClick(point));
        }

        markerLayer.appendChild(group);
    });
}

export async function ensureWorldDotMap(container) {
    if (!container) return null;

    const existing = mapInstances.get(container);
    if (existing) return existing;

    const dots = await getLandDots();
    const { markerLayer } = createMapSkeleton(container, dots);

    const instance = {
        setPoints(points = [], handlers = {}) {
            setMapPoints(markerLayer, points, handlers);
        }
    };

    mapInstances.set(container, instance);
    return instance;
}
