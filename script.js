let map;
let userCoords = [17.6599, 75.9064]; 
let markers = [];
let rawResultsCache = []; 
let locationCircle = null;
let centerMarker = null; 
let activeRouteLine = null; 
let debounceTimeout = null;
let isViewingBookmarks = false;
let currentSortingSequence = "nearest"; 

let touchStartY = 0;
let touchMoveY = 0;
const drawerState = { CURRENT: 'MID', EXPANDED: 'HIGH', COLLAPSED: 'LOW' };
let currentMobileState = drawerState.CURRENT;

const mapSkins = {
    light: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png', { attribution: '©OSM' }),
    dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png', { attribution: '©OSM' }),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: '©Esri' })
};
let currentSkinKey = 'light';

const categoryConfig = {
    restaurant: { color: '#f59e0b', icon: 'fa-utensils', badgeEmoji: '🍴' },
    pharmacy:   { color: '#10b981', icon: 'fa-pills', badgeEmoji: '💊' },
    hospital:   { color: '#ef4444', icon: 'fa-hospital', badgeEmoji: '🏥' },
    police:     { color: '#3b82f6', icon: 'fa-shield-halved', badgeEmoji: '🏢' }, 
    cafe:       { color: '#8b5cf6', icon: 'fa-mug-hot', badgeEmoji: '☕' },
    bank:       { color: '#64748b', icon: 'fa-building-columns', badgeEmoji: '🏦' }
};

function initMap() {
    map = L.map('map', { 
        zoomControl: false,
        doubleClickZoom: false,
        tap: false,
        touchZoom: true
    }).setView(userCoords, 13);

    mapSkins[currentSkinKey].addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);

    
    // Desktop double click support
    map.on('dblclick', function(e) {
        handleMapManualClick(e.latlng.lat, e.latlng.lng);
    });

    // Mobile double tap support
    let lastTapTime = 0;

    map.on('touchend', function(e) {

        const currentTime = new Date().getTime();
        const tapLength = currentTime - lastTapTime;

        if (tapLength < 300 && tapLength > 0) {

            const touch = e.originalEvent.changedTouches[0];

            const latlng = map.mouseEventToLatLng(touch);

            handleMapManualClick(latlng.lat, latlng.lng);
        }

        lastTapTime = currentTime;
    });

    map.getContainer().style.touchAction = "manipulation";
;
    
    map.on('zoomend', function() {
        if(rawResultsCache.length > 0) plotClusteredMarkers(rawResultsCache);
    });

    initMobileDrawerEngine();
    setTimeout(() => { map.invalidateSize(); }, 300);
    requestLiveLocation();
}

// --------------------------------------------------------
// MAP SKIN SWITCHER LOGIC
// --------------------------------------------------------
function toggleSkinMenu() {
    document.getElementById('skinMenuDropdown').classList.toggle('show');
}

function changeMapSkin(skinKey) {
    map.removeLayer(mapSkins[currentSkinKey]);
    mapSkins[skinKey].addTo(map);
    currentSkinKey = skinKey;
    
    document.querySelectorAll('.skin-option').forEach(el => el.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById('skinMenuDropdown').classList.remove('show');
}

document.addEventListener('click', () => {
    const dropdown = document.getElementById('skinMenuDropdown');
    if (dropdown) dropdown.classList.remove('show');
});

// --------------------------------------------------------
// BOOKMARKS CONTROLLER (LOCAL STORAGE)
// --------------------------------------------------------
function getBookmarks() {
    return JSON.parse(localStorage.getItem('geo_bookmarks')) || [];
}

function toggleBookmark(id, lat, lng, name, type) {
    let bookmarks = getBookmarks();
    const index = bookmarks.findIndex(b => b.id === id);
    
    if (index > -1) {
        bookmarks.splice(index, 1);
        event.target.classList.remove('bookmarked', 'fa-solid');
        event.target.classList.add('fa-regular');
    } else {
        bookmarks.push({ id, lat, lng, name, type, bookmarkedAt: Date.now() });
        event.target.classList.remove('fa-regular');
        event.target.classList.add('bookmarked', 'fa-solid');
    }
    localStorage.setItem('geo_bookmarks', JSON.stringify(bookmarks));
    if (isViewingBookmarks) renderBookmarksList();
}

function toggleBookmarkView() {
    const btn = document.getElementById('bookmarkPanelToggle');
    isViewingBookmarks = !isViewingBookmarks;
    const filterBar = document.getElementById('inlineFilterControlGroup');
    
    if (isViewingBookmarks) {
        btn.classList.add('active');
        btn.innerHTML = `<i class="fa-solid fa-star"></i>`;
        document.getElementById('panelCategoryLabel').innerText = "Viewing Bookmarked Safes";
        filterBar.style.display = "none";
        renderBookmarksList();
    } else {
        btn.classList.remove('active');
        btn.innerHTML = `<i class="fa-regular fa-star"></i>`;
        document.getElementById('panelCategoryLabel').innerText = "Discovery Category";
        document.getElementById('categorySelect').selectedIndex = 0;
        document.getElementById('results-panel').innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-map-location-dot"></i>
                <p>Double-tap a spot on the map to target a remote area or select a category below.</p>
            </div>`;
    }
}

function renderBookmarksList() {
    rawResultsCache = getBookmarks();
    renderCardsDomArray(rawResultsCache);
    plotClusteredMarkers(rawResultsCache);
}

// --------------------------------------------------------
// RESILIENT REAL-TIME STATUS ACCURACY FALLBACK CONTROLLER
// --------------------------------------------------------
function computeLiveStatus(openingHoursStr, categoryType) {
    if (openingHoursStr && openingHoursStr.trim().length > 0) {
        const cleanStr = openingHoursStr.toLowerCase();
        if (cleanStr.includes('24/7')) return `<span class="status-badge open">● Open 24/7</span>`;
        
        const currentHour = new Date().getHours();
        if (currentHour >= 9 && currentHour < 19) {
            return `<span class="status-badge open">● Open</span>`;
        }
        return `<span class="status-badge closed">● Closed</span>`;
    }
    
    const rightNow = new Date();
    const currentHour = rightNow.getHours();
    const currentDay = rightNow.getDay(); 

    if (categoryType === 'police' || categoryType === 'hospital') {
        return `<span class="status-badge open">● Open 24/7</span>`;
    }
    if (categoryType === 'bank') {
        if (currentDay === 0 || currentDay === 6) return `<span class="status-badge closed">● Closed (Weekend)</span>`;
        if (currentHour >= 10 && currentHour < 16) return `<span class="status-badge open">● Open</span>`;
        return `<span class="status-badge closed">● Closed</span>`;
    }
    if (categoryType === 'pharmacy') {
        if (currentHour >= 8 && currentHour < 22) return `<span class="status-badge open">● Open</span>`;
        return `<span class="status-badge closed">● Closed</span>`;
    }
    if (categoryType === 'restaurant' || categoryType === 'cafe') {
        if (currentHour >= 11 && currentHour < 23) return `<span class="status-badge open">● Open</span>`;
        return `<span class="status-badge closed">● Closed</span>`;
    }

    return `<span class="status-badge open">● Open</span>`;
}

// --------------------------------------------------------
// INSTANT MAP MARKER GRID-BASED CLUSTERING
// --------------------------------------------------------
function plotClusteredMarkers(items) {
    clearPreviousMarkersOnly();
    if (items.length === 0) return;

    const currentZoom = map.getZoom();
    let gridSize = 0.04; 
    if (currentZoom > 15) gridSize = 0.0015;
    else if (currentZoom > 13) gridSize = 0.005;
    else if (currentZoom > 11) gridSize = 0.015;

    const clusters = [];

    items.forEach(item => {
        let itemLat = item.lat;
        let itemLng = item.lon || item.lng;
        let matchedCluster = false;

        for (let cluster of clusters) {
            if (Math.abs(cluster.centerLat - itemLat) < gridSize && Math.abs(cluster.centerLng - itemLng) < gridSize) {
                cluster.nodes.push(item);
                cluster.centerLat = (cluster.centerLat + itemLat) / 2;
                cluster.centerLng = (cluster.centerLng + itemLng) / 2;
                matchedCluster = true;
                break;
            }
        }

        if (!matchedCluster) {
            clusters.push({ centerLat: itemLat, centerLng: itemLng, nodes: [item] });
        }
    });

    clusters.forEach(cluster => {
        const currentCategory = document.getElementById('categorySelect').value;
        
        if (cluster.nodes.length === 1) {
            const singleNode = cluster.nodes[0];
            const type = singleNode.type || currentCategory;
            const config = categoryConfig[type] || { color: '#6366f1', icon: 'fa-location-dot' };
            const name = singleNode.tags?.name || singleNode.name || `Location Node`;

            const customIcon = L.divIcon({
                html: `<div class="custom-map-marker" style="background:${config.color}; width:32px; height:32px;"><i class="fa-solid ${config.icon}" style="font-size:12px;"></i></div>`,
                className: 'marker-container-override', iconSize: [32, 32], iconAnchor: [16, 16]
            });

            const marker = L.marker([singleNode.lat, (singleNode.lon || singleNode.lng)], { icon: customIcon }).addTo(map)
                .bindPopup(`<b>${name}</b>`);
            markers.push(marker);
        } else {
            const clusterCount = cluster.nodes.length;
            const sampleNode = cluster.nodes[0];
            const type = sampleNode.type || currentCategory;
            const config = categoryConfig[type] || { color: '#4f46e5' };

            const clusterIcon = L.divIcon({
                html: `<div class="cluster-map-marker" style="background:${config.color}; width:36px; height:36px; line-height:32px;">${clusterCount}</div>`,
                className: 'cluster-container-override', iconSize: [36, 36], iconAnchor: [18, 18]
            });

            const marker = L.marker([cluster.centerLat, cluster.centerLng], { icon: clusterIcon }).addTo(map);
            marker.on('click', () => {
                map.flyTo([cluster.centerLat, cluster.centerLng], map.getZoom() + 2);
            });
            markers.push(marker);
        }
    });
}

function clearPreviousMarkersOnly() {
    markers.forEach(m => map.removeLayer(m));
    markers = [];
}

// --------------------------------------------------------
// IN-LIST LIVE FILTER & MULTI-ORDER SORT ENGINE
// --------------------------------------------------------
function handleLiveResultsFiltering() {
    const searchTerm = document.getElementById('resultsSearchInput').value.toLowerCase();
    let matchedSet = [...rawResultsCache];

    if (searchTerm) {
        matchedSet = matchedSet.filter(item => {
            const nodeName = (item.tags?.name || item.name || '').toLowerCase();
            return nodeName.includes(searchTerm);
        });
    }

    if (currentSortingSequence === "nearest") {
        matchedSet.sort((x, y) => {
            const distA = map.distance(userCoords, [x.lat, (x.lon || x.lng)]);
            const distB = map.distance(userCoords, [y.lat, (y.lon || y.lng)]);
            return distA - distB;
        });
    } else {
        matchedSet.sort((x, y) => {
            const nameA = (x.tags?.name || x.name || '').toLowerCase();
            const nameB = (y.tags?.name || y.name || '').toLowerCase();
            return nameA.localeCompare(nameB);
        });
    }

    renderCardsDomArray(matchedSet);
}

function toggleResultsSortingOrder() {
    const btn = document.getElementById('sortOrderToggleBtn');
    if (currentSortingSequence === "nearest") {
        currentSortingSequence = "alphabetical";
        btn.innerHTML = `<i class="fa-solid fa-sort-alpha-down"></i> A-Z`;
    } else {
        currentSortingSequence = "nearest";
        btn.innerHTML = `<i class="fa-solid fa-sort-amount-down-alt"></i> Nearest`;
    }
    handleLiveResultsFiltering();
}

function renderCardsDomArray(dataset) {
    const panel = document.getElementById('results-panel');
    panel.innerHTML = "";

    if (dataset.length === 0) {
        panel.innerHTML = `<div class="empty-state"><i class="fa-solid fa-filter-circle-xmark"></i><p>No listings match your filter parameters.</p></div>`;
        return;
    }

    const bookmarks = getBookmarks();
    const activeSelectCategory = document.getElementById('categorySelect').value;

    dataset.forEach(item => {
        const type = item.type || activeSelectCategory;
        const config = categoryConfig[type] || { color: '#6366f1', icon: 'fa-location-dot', badgeEmoji: '📍' };
        const name = item.tags?.name || item.name || `Unnamed ${type}`;
        const targetLat = item.lat;
        const targetLng = item.lon || item.lng;

        const distanceMeters = map.distance(userCoords, [targetLat, targetLng]);
        const distanceKm = (distanceMeters / 1000).toFixed(1);
        
        const liveStatusHtml = computeLiveStatus(item.tags?.opening_hours, type);
        const isSaved = bookmarks.some(b => b.id === String(item.id));
        const starClass = isSaved ? 'fa-solid bookmarked' : 'fa-regular';

        // Native Multi-Platform Google Maps Directions URL Payload Deep-link
        const googleMapsDirectionsUrl = `https://www.google.com/maps/dir/?api=1&origin=${userCoords[0]},${userCoords[1]}&destination=${targetLat},${targetLng}&travelmode=driving`;

        const card = document.createElement('div');
        card.className = 'location-card';
        card.innerHTML = `
            <div class="icon-circle" style="background:${config.color}15; color:${config.color}">
                ${config.badgeEmoji}
            </div>
            <div class="card-info">
                <h4>${name}</h4>
                <p>${distanceKm} km away</p>
                ${liveStatusHtml}
            </div>
            <div class="card-actions">
                <a href="${googleMapsDirectionsUrl}" target="_blank" class="nav-link" title="Directions on Google Maps" onclick="event.stopPropagation();">
                    <i class="fa-solid fa-diamond-turn-right" style="color: var(--primary);"></i>
                </a>
                <button class="card-bookmark-btn ${starClass} fa-star" onclick="toggleBookmark('${item.id}', ${targetLat}, ${targetLng}, '${name.replace(/'/g, "\\'")}', '${type}'); event.stopPropagation();"></button>
            </div>`;
        
        card.onclick = () => {
            if (window.innerWidth <= 768) resetDrawerToMid();
            map.flyTo([targetLat, targetLng], 16);
            drawRouteToTarget(targetLat, targetLng);
        };
        panel.appendChild(card);
    });
}

// --------------------------------------------------------
// MAP INFRASTRUCTURE VECTOR ROUTE DRAWING
// --------------------------------------------------------
function drawRouteToTarget(destLat, destLng) {
    if (activeRouteLine) map.removeLayer(activeRouteLine);
    
    const points = [userCoords, [destLat, destLng]];
    activeRouteLine = L.polyline(points, {
        color: '#4f46e5',
        weight: 4,
        opacity: 0.8,
        dashArray: '8, 8',
        lineCap: 'round'
    }).addTo(map);
    
    map.fitBounds(activeRouteLine.getBounds(), { padding: [50, 50] });
}

// --------------------------------------------------------
// GESTURES MOBILE PANEL DRAWER CONTROLLER
// --------------------------------------------------------
function initMobileDrawerEngine() {
    const drawer = document.getElementById('sidebarDrawer');
    const resultsContainer = document.getElementById('results-panel');

    drawer.addEventListener('touchstart', (e) => {
        if (resultsContainer.scrollTop === 0 || e.target.closest('.search-section') || e.target.classList.contains('drawer-handle')) {
            touchStartY = e.touches[0].clientY;
        }
    }, { passive: true });

    drawer.addEventListener('touchmove', (e) => {
        if (window.innerWidth > 768) return; 
        touchMoveY = e.touches[0].clientY;
        const deltaY = touchMoveY - touchStartY;

        if (deltaY < -40 && currentMobileState !== drawerState.EXPANDED) expandDrawer();
        else if (deltaY > 40) {
            if (currentMobileState === drawerState.EXPANDED && resultsContainer.scrollTop === 0) resetDrawerToMid();
            else if (currentMobileState === drawerState.CURRENT) collapseDrawer();
        }
    }, { passive: true });
}

function expandDrawer() {
    const drawer = document.getElementById('sidebarDrawer');
    drawer.classList.remove('collapsed'); drawer.classList.add('expanded');
    currentMobileState = drawerState.EXPANDED;
    setTimeout(() => { map.invalidateSize(); }, 300);
}

function resetDrawerToMid() {
    const drawer = document.getElementById('sidebarDrawer');
    drawer.classList.remove('expanded', 'collapsed');
    currentMobileState = drawerState.CURRENT;
    setTimeout(() => { map.invalidateSize(); }, 300);
}

function collapseDrawer() {
    const drawer = document.getElementById('sidebarDrawer');
    drawer.classList.remove('expanded'); drawer.classList.add('collapsed');
    currentMobileState = drawerState.COLLAPSED;
    setTimeout(() => { map.invalidateSize(); }, 300);
}

function handleMapManualClick(lat, lng) {
    userCoords = [lat, lng]; 
    clearPrevious();
    isViewingBookmarks = false;
    document.getElementById('bookmarkPanelToggle').classList.remove('active');
    document.getElementById('bookmarkPanelToggle').innerHTML = `<i class="fa-regular fa-star"></i>`;
    document.getElementById('panelCategoryLabel').innerText = "Discovery Category";
    document.getElementById('inlineFilterControlGroup').style.display = "none";
    
    const radiusMeters = document.getElementById('radiusInput').value * 1000;
    const panel = document.getElementById('results-panel');

    if (locationCircle) {
        locationCircle.setLatLng(userCoords).setRadius(radiusMeters);
    } else {
        locationCircle = L.circle(userCoords, { color: '#4f46e5', fillColor: '#4f46e5', fillOpacity: 0.1, radius: radiusMeters }).addTo(map);
    }

    if (centerMarker) map.removeLayer(centerMarker);
    
    const customCenterIcon = L.divIcon({
        html: `<div class="custom-map-marker" style="background:#1e1b4b; width:34px; height:34px; border-color:#4f46e5;"><i class="fa-solid fa-crosshairs" style="font-size:14px;"></i></div>`,
        className: 'center-marker-container', iconSize: [34, 34], iconAnchor: [17, 17]
    });
    
    centerMarker = L.marker(userCoords, { icon: customCenterIcon }).addTo(map).bindPopup("<b>Target Area Locked</b>").openPopup();
    
    panel.innerHTML = `
        <div class="empty-state">
            <i class="fa-solid fa-bullseye" style="color: #4f46e5; opacity: 1;"></i>
            <p>Target custom pin set successfully!<br>Now pick a discovery category below to find assets near this area.</p>
        </div>`;
        
    document.getElementById('categorySelect').selectedIndex = 0;
    if (currentMobileState === drawerState.COLLAPSED) resetDrawerToMid();
}

function updateRadiusDisplay(val) {
    document.getElementById('radiusVal').innerText = `${val} km`;
    clearTimeout(debounceTimeout);
    const currentCategory = document.getElementById('categorySelect').value;
    if (currentCategory && !isViewingBookmarks) {
        debounceTimeout = setTimeout(() => { findPlaces(currentCategory); }, 400);
    }
}

function requestLiveLocation() {
    const btn = document.getElementById('locateBtn');
    const panel = document.getElementById('results-panel');
    if (!navigator.geolocation) return;

    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Locating...`;

    navigator.geolocation.getCurrentPosition(
        (position) => {
            userCoords = [position.coords.latitude, position.coords.longitude];
            map.invalidateSize(); map.flyTo(userCoords, 15, { duration: 1.8 });

            if (centerMarker) { map.removeLayer(centerMarker); centerMarker = null; }
            if (locationCircle) map.removeLayer(locationCircle);

            locationCircle = L.circle(userCoords, {
                color: '#4f46e5', fillColor: '#4f46e5', fillOpacity: 0.1,
                radius: document.getElementById('radiusInput').value * 1000
            }).addTo(map);

            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-location-arrow"></i> Use My Current Location`;
            panel.innerHTML = '<div class="empty-state"><i class="fa-solid fa-street-view"></i><p>Position locked! Choose a discovery category or double-tap elsewhere on the map.</p></div>';
            
            document.getElementById('categorySelect').selectedIndex = 0;
            clearPrevious();
            if (window.innerWidth <= 768) resetDrawerToMid();
        },
        () => {
            btn.disabled = false; btn.innerHTML = `<i class="fa-solid fa-location-arrow"></i> Use My Current Location`;
        },
        { enableHighAccuracy: true, timeout: 8000 }
    );
}

async function searchManualLocation() {
    const query = document.getElementById('locationInput').value;
    if (!query) return;
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (data[0]) {
            userCoords = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
            map.invalidateSize(); map.flyTo(userCoords, 14, { duration: 1.8 });
            clearPrevious();
            document.getElementById('categorySelect').selectedIndex = 0;
        }
    } catch (e) {}
}

async function fetchWithRetry(url, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url);
            if (response.ok) return await response.json();
            if (response.status === 429 || response.status >= 500) {
                await new Promise(res => setTimeout(res, delay)); continue;
            }
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, delay));
        }
    }
    throw new Error("API Limit reached");
}

async function findPlaces(type) {
    isViewingBookmarks = false;
    document.getElementById('bookmarkPanelToggle').classList.remove('active');
    document.getElementById('bookmarkPanelToggle').innerHTML = `<i class="fa-regular fa-star"></i>`;
    document.getElementById('resultsSearchInput').value = "";
    
    const panel = document.getElementById('results-panel');
    panel.innerHTML = '<div class="empty-state"><i class="fa-solid fa-satellite fa-spin"></i><p>Scanning radius...</p></div>';
    clearPrevious();

    if (window.innerWidth <= 768) expandDrawer();

    const chosenRadiusKm = document.getElementById('radiusInput').value;
    const radiusMeters = chosenRadiusKm * 1000;

    const query = `[out:json][timeout:25];node["amenity"="${type}"](around:${radiusMeters}, ${userCoords[0]}, ${userCoords[1]});out;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    try {
        const data = await fetchWithRetry(url, 3, 1500);
        panel.innerHTML = "";

        if (!data.elements || data.elements.length === 0) {
            document.getElementById('inlineFilterControlGroup').style.display = "none";
            panel.innerHTML = `<div class="empty-state"><i class="fa-solid fa-folder-open"></i><p>Zero matches inside ${chosenRadiusKm} km.</p></div>`;
            return;
        }

        rawResultsCache = data.elements;
        document.getElementById('inlineFilterControlGroup').style.display = "flex";
        
        handleLiveResultsFiltering();
        plotClusteredMarkers(rawResultsCache);
    } catch (e) { 
        panel.innerHTML = '<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><p>Network delayed.</p></div>'; 
    }
}

function clearPrevious() {
    clearPreviousMarkersOnly();
    rawResultsCache = [];
    if (activeRouteLine) { map.removeLayer(activeRouteLine); activeRouteLine = null; }
}

function handleSearch(e) { if (e.key === 'Enter') searchManualLocation(); }
window.onload = initMap;