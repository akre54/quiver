// --- Scene Update Module ---
// Allows re-importing from Figma while preserving bindings on existing layers

// Global setting for update mode
var __sceneUpdateModeEnabled = false;

/**
 * Extract Figma ID from layer name
 * Layer names are tagged with: "LayerName @fid:1234:5678"
 */
function extractFigmaIdFromName(layerName) {
    if (!layerName) return null;
    var match = (layerName + '').match(/@fid:([^\s]+)/);
    return match ? match[1] : null;
}

/**
 * Tag a Cavalry layer with its Figma ID (appended to name)
 * Called during fresh import to enable future updates
 */
function tagLayerWithFigmaId(layerId, figmaId) {
    if (!layerId || !figmaId) return;
    try {
        var currentName = api.getNiceName(layerId) || '';
        // Don't add duplicate tag
        if (currentName.indexOf('@fid:') !== -1) return;
        var newName = currentName + ' @fid:' + figmaId;
        api.rename(layerId, newName);
    } catch (e) {
        // Silently fail - tagging is optional
    }
}

/**
 * Remove the Figma ID tag from a layer name (for display purposes)
 */
function getCleanLayerName(layerName) {
    if (!layerName) return '';
    return (layerName + '').replace(/\s*@fid:[^\s]+/, '').trim();
}

/**
 * Build an index of existing layers that have Figma IDs
 * Uses the current selection as the root to traverse
 * Returns: { figmaId: { id: cavalryId, type: layerType, name: layerName }, ... }
 */
function buildExistingLayerIndex() {
    var index = {};

    try {
        var selection = api.getSelection();
        if (!selection || selection.length === 0) {
            console.info('[Quiver] No selection - will create new layers');
            return index;
        }

        // Index the selected layers and attempt to get their children
        for (var i = 0; i < selection.length; i++) {
            indexLayerAndChildren(selection[i], index);
        }

        var count = 0;
        for (var k in index) count++;
        if (count > 0) {
            console.info('[Quiver] Found ' + count + ' existing layers with Figma IDs');
        }
    } catch (e) {
        console.warn('[Quiver] Error building layer index: ' + e.message);
    }

    return index;
}

/**
 * Recursively index a layer and its children (via __groupDirectChildren tracking)
 */
function indexLayerAndChildren(layerId, index) {
    if (!layerId || !api.layerExists(layerId)) return;

    try {
        var name = api.getNiceName(layerId) || '';
        var figmaId = extractFigmaIdFromName(name);

        if (figmaId) {
            var layerType = 'unknown';
            try { layerType = api.getType(layerId); } catch (e) {}

            index[figmaId] = {
                id: layerId,
                type: layerType,
                name: getCleanLayerName(name)
            };
        }

        // Try to get children if this is tracked in __groupDirectChildren
        if (typeof __groupDirectChildren !== 'undefined' && __groupDirectChildren[layerId]) {
            var children = __groupDirectChildren[layerId];
            for (var i = 0; i < children.length; i++) {
                indexLayerAndChildren(children[i], index);
            }
        }
    } catch (e) {
        // Silently skip problematic layers
    }
}

/**
 * Build a map of SVG nodes to existing Cavalry layers
 * Returns: { figmaId: cavalryLayerId, ... } for matched elements
 */
function buildMatchMap(model, existingIndex) {
    var matchMap = {};
    var stats = { matched: 0, unmatched: 0 };

    function traverse(node) {
        if (!node) return;

        // Get the Figma ID from SVG
        var figmaId = node.attrs && node.attrs.id;

        if (figmaId && existingIndex[figmaId]) {
            matchMap[figmaId] = existingIndex[figmaId].id;
            stats.matched++;
        } else if (figmaId) {
            stats.unmatched++;
        }

        // Recurse into children
        if (node.children) {
            for (var i = 0; i < node.children.length; i++) {
                traverse(node.children[i]);
            }
        }
    }

    traverse(model);

    console.info('[Quiver] Match results: ' + stats.matched + ' matched, ' + stats.unmatched + ' new');

    return matchMap;
}

/**
 * Check if a layer has any connected shaders (gradients, images)
 * If so, we preserve them rather than overwriting with simple fill
 */
function hasConnectedShaders(layerId) {
    try {
        // We can't easily query connections, so check if material has non-default values
        // For now, we'll update fills conservatively
        return false;
    } catch (e) {
        return false;
    }
}

/**
 * Update an existing layer with properties from the new SVG node
 * Preserves all connections/bindings by only calling api.set() on properties
 */
function updateExistingLayer(cavalryId, node, vb, inheritedTranslate, inheritedScale, parentMatrix) {
    if (!cavalryId || !node || !api.layerExists(cavalryId)) return false;

    inheritedTranslate = inheritedTranslate || {x: 0, y: 0};
    inheritedScale = inheritedScale || {x: 1, y: 1};

    try {
        var updates = {};
        var nodeType = node.type;
        var layerType = api.getType(cavalryId);

        // Parse node's own transform
        var nodeT = parseTranslate(node.attrs && node.attrs.transform);

        // Handle rectangle updates
        if (nodeType === 'rect' && (layerType === 'rectangle' || layerType === 'rectangleShape' || layerType === 'basicShape')) {
            var x = parseFloat(node.attrs.x || '0');
            var y = parseFloat(node.attrs.y || '0');
            var w = parseFloat(node.attrs.width || '0');
            var h = parseFloat(node.attrs.height || '0');

            // Apply transforms
            if (node.attrs && node.attrs.transform && node.attrs.transform.indexOf('matrix') !== -1) {
                var tl = applyMatrixToPoint(node.attrs.transform, x, y);
                var br = applyMatrixToPoint(node.attrs.transform, x + w, y + h);
                x = Math.min(tl.x, br.x);
                y = Math.min(tl.y, br.y);
                w = Math.abs(br.x - tl.x);
                h = Math.abs(br.y - tl.y);
            } else {
                x = x + nodeT.x + inheritedTranslate.x;
                y = y + nodeT.y + inheritedTranslate.y;
            }

            var centre = svgToCavalryPosition(x + w/2, y + h/2, vb);
            updates['position.x'] = centre.x;
            updates['position.y'] = centre.y;
            updates['generator.dimensions'] = [w, h];

            // Corner radius
            var rx = parseFloat(node.attrs.rx || '0');
            var ry = parseFloat(node.attrs.ry || '0');
            var cr = Math.max(0, Math.min(rx || ry || 0, Math.min(w, h) / 2));
            if (cr > 0) {
                updates['generator.cornerRadius'] = cr;
            }
        }

        // Handle circle updates
        else if (nodeType === 'circle' && (layerType === 'ellipse' || layerType === 'ellipseShape')) {
            var cx = parseFloat(node.attrs.cx || '0');
            var cy = parseFloat(node.attrs.cy || '0');
            var r = parseFloat(node.attrs.r || '0');

            if (node.attrs && node.attrs.transform && node.attrs.transform.indexOf('matrix') !== -1) {
                var transformed = applyMatrixToPoint(node.attrs.transform, cx, cy);
                cx = transformed.x + inheritedTranslate.x;
                cy = transformed.y + inheritedTranslate.y;
            } else {
                cx = cx + nodeT.x + inheritedTranslate.x;
                cy = cy + nodeT.y + inheritedTranslate.y;
            }

            var pos = svgToCavalryPosition(cx, cy, vb);
            updates['position.x'] = pos.x;
            updates['position.y'] = pos.y;
            updates['generator.radius'] = [r, r];
        }

        // Handle ellipse updates
        else if (nodeType === 'ellipse' && (layerType === 'ellipse' || layerType === 'ellipseShape')) {
            var cx = parseFloat(node.attrs.cx || '0');
            var cy = parseFloat(node.attrs.cy || '0');
            var rx = parseFloat(node.attrs.rx || '0');
            var ry = parseFloat(node.attrs.ry || '0');

            if (node.attrs && node.attrs.transform && node.attrs.transform.indexOf('matrix') !== -1) {
                var transformed = applyMatrixToPoint(node.attrs.transform, cx, cy);
                cx = transformed.x + inheritedTranslate.x;
                cy = transformed.y + inheritedTranslate.y;
            } else {
                cx = cx + nodeT.x + inheritedTranslate.x;
                cy = cy + nodeT.y + inheritedTranslate.y;
            }

            var pos = svgToCavalryPosition(cx, cy, vb);
            updates['position.x'] = pos.x;
            updates['position.y'] = pos.y;
            updates['generator.radius'] = [rx, ry];
        }

        // Handle group position updates
        else if ((nodeType === 'g' || nodeType === 'svg') && (layerType === 'group' || layerType === 'null' || layerType === 'nullShape')) {
            // Groups: update position if transform is present
            var rotDeg = getRotationDegFromTransform(node.attrs && node.attrs.transform || '');
            if (Math.abs(rotDeg) > 0.0001) {
                updates['rotation'] = -rotDeg;
            }

            if (nodeT.x !== 0 || nodeT.y !== 0) {
                var zero = svgToCavalryPosition(0, 0, vb);
                var moved = svgToCavalryPosition(nodeT.x, nodeT.y, vb);
                updates['position.x'] = moved.x - zero.x;
                updates['position.y'] = moved.y - zero.y;
            }
        }

        // Apply rotation (for shapes)
        if (nodeType !== 'g' && nodeType !== 'svg') {
            var rotDeg = getRotationDegFromTransform(node.attrs && node.attrs.transform || '');
            if (Math.abs(rotDeg) > 0.0001) {
                updates['rotation'] = -rotDeg;
            }
        }

        // Update fill color (only if no shader is connected)
        if (!hasConnectedShaders(cavalryId)) {
            var fillColor = node.attrs && (node.attrs.fill || (node.attrs.style && extractStyleProperty(node.attrs.style, 'fill')));
            if (fillColor && fillColor !== 'none' && !fillColor.startsWith('url(')) {
                var color = parseColorToRGBA(fillColor);
                if (color) {
                    // Apply fill color - format depends on Cavalry version
                    try {
                        updates['material.materialColor'] = fillColor;
                    } catch (e) {}
                }
            }

            // Fill opacity
            var fillOpacity = node.attrs && (node.attrs['fill-opacity'] || (node.attrs.style && extractStyleProperty(node.attrs.style, 'fill-opacity')));
            if (fillOpacity !== null && fillOpacity !== undefined) {
                var alpha = parseFloat(fillOpacity);
                if (!isNaN(alpha)) {
                    updates['material.alpha'] = Math.round(alpha * 100);
                }
            }
        }

        // Update stroke properties
        var strokeColor = node.attrs && (node.attrs.stroke || (node.attrs.style && extractStyleProperty(node.attrs.style, 'stroke')));
        if (strokeColor && strokeColor !== 'none' && !strokeColor.startsWith('url(')) {
            try {
                updates['stroke.strokeColor'] = strokeColor;
            } catch (e) {}
        }

        var strokeWidth = node.attrs && (node.attrs['stroke-width'] || (node.attrs.style && extractStyleProperty(node.attrs.style, 'stroke-width')));
        if (strokeWidth !== null && strokeWidth !== undefined) {
            var sw = parseFloat(strokeWidth);
            if (!isNaN(sw)) {
                updates['stroke.width'] = sw;
            }
        }

        // Apply all updates in one call
        var updateCount = 0;
        for (var k in updates) updateCount++;

        if (updateCount > 0) {
            api.set(cavalryId, updates);
            return true;
        }

        return true;

    } catch (e) {
        console.warn('[Quiver] Error updating layer: ' + e.message);
        return false;
    }
}

/**
 * Main entry point for scene updates
 * Parses SVG, matches existing layers, updates matched, creates new ones
 */
function processAndUpdateSVG(svgCode, targetGroupId) {
    try {
        // Validate SVG content
        if (!svgCode || (svgCode + '').trim() === '') {
            console.error('[Quiver] No valid SVG content for update');
            return;
        }

        if (!svgCode.includes('<svg') || !svgCode.includes('</svg>')) {
            console.error('[Quiver] Invalid SVG format for update');
            return;
        }

        console.info('[Quiver] Starting scene update...');

        // Parse SVG
        var vb = extractViewBox(svgCode);
        if (!vb) vb = {x: 0, y: 0, width: 1000, height: 1000};

        var model = parseSVGStructure(svgCode);

        // Pre-process SVG (same as fresh import)
        try { mergeFillStrokePairs(model); } catch (e) {}

        // Extract context (filters, patterns, masks, gradients)
        try {
            __svgFilterMap = extractFilters(svgCode) || {};
        } catch (e) { __svgFilterMap = {}; }

        try {
            var patterns = extractPatterns(svgCode) || {};
            setPatternContext(patterns);
        } catch (e) { setPatternContext({}); }

        try {
            var masks = extractMasks(svgCode) || {};
            setMaskContext(masks);
        } catch (e) { setMaskContext({}); }

        var gradientMap = {};
        var gradsArr = extractGradients(svgCode);
        for (var gi = 0; gi < gradsArr.length; gi++) {
            var gid = gradsArr[gi].id;
            if (gid) gradientMap[gid] = gradsArr[gi];
        }
        setGradientContext(gradientMap);

        // Build index of existing layers (from selection)
        var existingIndex = buildExistingLayerIndex();

        // Build match map
        var matchMap = buildMatchMap(model, existingIndex);

        // Track which existing layers were matched (for deletion detection)
        var matchedExistingIds = {};
        for (var figmaId in matchMap) {
            matchedExistingIds[matchMap[figmaId]] = true;
        }

        // Reset counters
        __imageCounter = 0;
        __imageNamingContext = {};
        __groupCounter = 0;

        // Stats
        var stats = {
            updated: 0,
            created: 0,
            deleted: 0,
            groups: 0,
            rects: 0,
            circles: 0,
            ellipses: 0,
            texts: 0,
            paths: 0
        };

        // Process nodes with update logic
        function updateOrImportNode(node, parentId, vb, inheritedTranslate, stats, model, inHiddenDefs, inheritedScale, parentMatrix) {
            var figmaId = node.attrs && node.attrs.id;
            var existingLayerId = figmaId && matchMap[figmaId];

            if (existingLayerId && api.layerExists(existingLayerId)) {
                // Update existing layer
                var updated = updateExistingLayer(existingLayerId, node, vb, inheritedTranslate, inheritedScale, parentMatrix);
                if (updated) {
                    stats.updated++;
                }

                // Process children for groups
                if (node.type === 'g' || node.type === 'svg') {
                    for (var i = 0; i < node.children.length; i++) {
                        updateOrImportNode(node.children[i], existingLayerId, vb, {x: 0, y: 0}, stats, model, false, inheritedScale, parentMatrix);
                    }
                }

                return existingLayerId;
            } else {
                // Create new layer (using existing importNode)
                var newId = importNode(node, parentId, vb, inheritedTranslate, stats, model, inHiddenDefs, inheritedScale, parentMatrix);

                // Tag with Figma ID for future updates
                if (newId && figmaId) {
                    tagLayerWithFigmaId(newId, figmaId);
                }

                stats.created++;
                return newId;
            }
        }

        // Process all top-level nodes
        var rootId = null;
        for (var i = 0; i < model.children.length; i++) {
            updateOrImportNode(model.children[i], rootId, vb, {x: 0, y: 0}, stats, model, false, {x: 1, y: 1}, null);
        }

        // Handle deletions: layers in existingIndex that weren't matched
        for (var existingFigmaId in existingIndex) {
            var existingLayer = existingIndex[existingFigmaId];
            if (!matchedExistingIds[existingLayer.id]) {
                try {
                    api.deleteLayer(existingLayer.id);
                    stats.deleted++;
                    console.info('[Quiver] Deleted removed layer: ' + existingLayer.name);
                } catch (e) {
                    // Layer may have already been deleted as part of a parent
                }
            }
        }

        // Post-process (same as fresh import)
        try { unifyPathStrokePairsAfterImport(); } catch (e) {}

        console.info('[Quiver] Update complete - updated: ' + stats.updated + ', created: ' + stats.created + ', deleted: ' + stats.deleted);

    } catch (e) {
        var errorMsg = e && e.message ? e.message : 'Update failed';
        console.error('[Quiver] Error: ' + errorMsg);
    }
}

/**
 * Enable or disable scene update mode
 */
function setSceneUpdateMode(enabled) {
    __sceneUpdateModeEnabled = !!enabled;
    console.info('[Quiver] Scene update mode: ' + (__sceneUpdateModeEnabled ? 'enabled' : 'disabled'));
}

/**
 * Check if scene update mode is enabled
 */
function isSceneUpdateModeEnabled() {
    return __sceneUpdateModeEnabled;
}

// Export functions for use by webserver and UI
// (These are available globally in the Cavalry scripting environment)
