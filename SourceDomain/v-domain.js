(() => {
    // --- Library State ---
    let iframeElement = null;
    let previewOrigin = null;
    let isReady = false;
    // !! NEW: Holds the IFileSystem adapter instance provided by the user !!
    let fileSystemAdapter = null;
    // Function to determine default file for directory requests
    let defaultFilePathResolver = (path) => (path === '/' || path.endsWith('/')) ? '/index.html' : null;
    // Callback functions
    let onLogCallback = console.log;
    let onErrorCallback = console.error;
    // Callback for when SW asks for proxy permission
    let onRequestProxyPermissionCallback = defaultRequestProxyPermissionHandler; // File status handled internally now
    // Readiness promise
    let readyPromiseResolve = null;
    const readyPromise = new Promise(resolve => { readyPromiseResolve = resolve; });
    // Current settings sent to SW
    let currentSwSettings = {};


    // --- Default Handlers ---

    // Default logic to ask user for proxy permission (same as before)
    function defaultRequestProxyPermissionHandler(requestId, requestDetails) {
        const { url, method, headers } = requestDetails;
        // Simple text-based prompt
        const headerString = Object.entries(headers || {})
            .map(([key, value]) => `  ${key}: ${value}`)
            .join('\n');
        const confirmationMessage = `The preview environment wants to make a '${method}' request to:\n\n${url}\n\n${headerString ? 'Headers:\n' + headerString + '\n' : ''}\nAllow this request? (This will use the configured proxy)`;

        try {
            const allowed = window.confirm(confirmationMessage);
            onLogCallback(`VDomain: Proxy permission for ${url}: ${allowed ? 'Granted' : 'Denied'}`);
            VDomain._sendProxyResponse(requestId, allowed);
        } catch (error) {
             onErrorCallback(`VDomain: Error during proxy confirmation UI for ${url}:`, error);
             // Deny if the UI fails for any reason
             VDomain._sendProxyResponse(requestId, false);
        }
    }

    // --- Internal File Status Handler (using IFileSystem) ---
    async function internalRequestFileStatusHandler(requestId, requestedPath, cachedMetadata) {
        if (!fileSystemAdapter) {
            onErrorCallback(`VDomain: Received file status request for '${requestedPath}' but no IFileSystem adapter is configured.`);
            VDomain._sendFileStatusResponse(requestId, 'FILE_NOT_FOUND', { path: requestedPath });
            return;
        }

        onLogCallback(`VDomain: Received file status request for '${requestedPath}', cached modified (SW): ${cachedMetadata?.lastModified}`);

        const resolvedPath = defaultFilePathResolver(requestedPath) || requestedPath;
        if (resolvedPath !== requestedPath) {
             onLogCallback(`VDomain: Resolved requested path '${requestedPath}' to default file path '${resolvedPath}'`);
        }

        try {
            // 1. Check if the resolved path exists in the file system
            const exists = await fileSystemAdapter.exists(resolvedPath);

            if (!exists) {
                onLogCallback(`VDomain: File '${resolvedPath}' (resolved from '${requestedPath}') not found in IFileSystem adapter '${fileSystemAdapter.adapterName}'.`);
                VDomain._sendFileStatusResponse(requestId, 'FILE_NOT_FOUND', { path: requestedPath });
                return;
            }

            // 2. Get metadata from the file system
            const fsMetadata = await fileSystemAdapter.getMetadata(resolvedPath);

            // Ensure it's a file
            if (fsMetadata.type !== 'file') {
                 onErrorCallback(`VDomain: Path '${resolvedPath}' exists but is not a file in IFileSystem adapter '${fileSystemAdapter.adapterName}'.`);
                 // Treat as not found for the SW request purpose
                 VDomain._sendFileStatusResponse(requestId, 'FILE_NOT_FOUND', { path: requestedPath });
                 return;
            }

            const fsLastModified = fsMetadata.modifiedAt.getTime(); // Get timestamp
            onLogCallback(`VDomain: File '${resolvedPath}' found in IFileSystem. Last Modified (FS): ${fsLastModified}`);

            // 3. Compare timestamps (if SW provided one)
            if (cachedMetadata && cachedMetadata.lastModified && cachedMetadata.lastModified >= fsLastModified) {
                // Cache is up-to-date or newer (allow newer, might happen with clock sync issues)
                onLogCallback(`VDomain: SW cache for '${requestedPath}' is up-to-date.`);
                VDomain._sendFileStatusResponse(requestId, 'USE_CACHED', { path: requestedPath });
            } else {
                // Cache is outdated, doesn't exist, or FS doesn't provide reliable timestamp (treat as outdated)
                onLogCallback(`VDomain: SW cache for '${requestedPath}' needs update or initial load.`);
                // Read the file content
                const blobContent = await fileSystemAdapter.readFile(resolvedPath);
                // Determine mime type (you might want a more sophisticated way)
                const mimeType = determineMimeType(resolvedPath, blobContent);

                VDomain._sendFileStatusResponse(requestId, 'UPDATE_AND_SERVE', {
                    path: requestedPath, // Respond with the path SW asked for
                    content: blobContent, // Send Blob directly (SW needs to handle it)
                    mimeType: mimeType,
                    lastModified: fsLastModified
                });
            }

        } catch (error) {
            // Handle IFileSystem specific errors or generic errors
             onErrorCallback(`VDomain: Error handling file status for '${requestedPath}' using IFileSystem adapter '${fileSystemAdapter?.adapterName || 'N/A'}':`, error);
             // Use instanceof to check for specific IFileSystem errors if needed
             // Example: if (error instanceof PathNotFoundError) { ... }
             // For now, treat most errors as file not found for the SW
             VDomain._sendFileStatusResponse(requestId, 'FILE_NOT_FOUND', { path: requestedPath });
        }
    }


    // --- Message Listener (from Loader/SW) ---
    function handleIncomingMessage(event) {
        if (event.origin !== previewOrigin) return;
        const message = event.data;
        if (!message || typeof message !== 'object') return;

        switch (message.type) {
             // ... (SW_READY, SW_ERROR, SW_UNSUPPORTED same logic) ...
             case 'SW_FULLY_READY':
                 onLogCallback('VDomain: Service Worker is fully ready.');
                 isReady = true;
                 if (readyPromiseResolve) {
                     readyPromiseResolve();
                     readyPromiseResolve = null;
                 }
                 // Send initial settings if they were set before ready
                 if (Object.keys(currentSwSettings).length > 0) {
                     VDomain.updateSettings(currentSwSettings);
                 }
                 // !! No initial file push - SW will ask for files as needed !!
                break;
            case 'SW_MSG':
                handleSwMessage(message.payload);
                break;
        }
    }

    // Handle messages specifically from the Service Worker
    function handleSwMessage(payload) {
        if (!payload || typeof payload !== 'object') return;
         onLogCallback('VDomain: Received message from SW:', payload.type, payload.payload);
        switch (payload.type) {
            case 'ASK_FILE_STATUS': // Handled by internalRequestFileStatusHandler now
                if (payload.payload) {
                    internalRequestFileStatusHandler(
                        payload.payload.requestId,
                        payload.payload.path,
                        payload.payload.cachedMetadata
                    );
                }
                break;
            case 'ASK_PROXY_PERMISSION': // Still uses the callback
                 if (onRequestProxyPermissionCallback && payload.payload) {
                    onRequestProxyPermissionCallback(
                        payload.payload.requestId,
                        payload.payload.requestDetails
                    );
                }
                 break;
             // ... (LOG, ERROR cases same as before) ...
        }
    }


    // --- Public API ---
    const VDomain = {
        /**
         * Initializes the VDomain library.
         * @param {object} options
         * @param {string|HTMLIFrameElement} options.iframeSelector
         * @param {string} options.previewOrigin
         * @param {IFileSystem} options.fileSystemAdapter - An initialized instance of an IFileSystem implementation.
         * @param {function} [options.defaultFilePathResolver] - Function(requestedPath) => defaultPath | null.
         * @param {object} [options.initialSettings] - Initial settings for the SW (e.g., { proxyUrl: '...', requestTimeoutMs: 10000 }).
         * @param {function} [options.onLog]
         * @param {function} [options.onError]
         * @param {function} [options.onRequestProxyPermission] - Callback(requestId, requestDetails)
         * @returns {Promise<void>} Resolves when SW is fully ready.
         */
        init: (options) => {
            if (!options || !options.iframeSelector || !options.previewOrigin) {
                throw new Error("VDomain.init requires 'iframeSelector' and 'previewOrigin'.");
            }
            // !! NEW: Validate fileSystemAdapter !!
            if (!options.fileSystemAdapter || typeof options.fileSystemAdapter.readFile !== 'function') {
                throw new Error("VDomain.init requires a valid 'fileSystemAdapter' implementing the IFileSystem interface.");
            }

            if (typeof options.iframeSelector === 'string') {
                iframeElement = document.querySelector(options.iframeSelector);
            } else if (options.iframeSelector instanceof HTMLIFrameElement) {
                iframeElement = options.iframeSelector;
            }

            if (!iframeElement) {
                throw new Error(`VDomain.init: Could not find iframe element with selector "${options.iframeSelector}".`);
            }

            previewOrigin = options.previewOrigin;
            fileSystemAdapter = options.fileSystemAdapter; // Store the adapter
            defaultFilePathResolver = options.defaultFilePathResolver || ((path) => (path === '/' || path.endsWith('/')) ? '/index.html' : null);
            currentSwSettings = options.initialSettings || {};
            onLogCallback = options.onLog || console.log;
            onErrorCallback = options.onError || console.error;
            onRequestProxyPermissionCallback = options.onRequestProxyPermission || defaultRequestProxyPermissionHandler;

            window.removeEventListener('message', handleIncomingMessage);
            window.addEventListener('message', handleIncomingMessage);

            onLogCallback(`VDomain: Initialized with IFileSystem adapter '${fileSystemAdapter.adapterName}'. Waiting for SW readiness...`);
            return readyPromise;
        },

        isReady: () => isReady,
        whenReady: () => readyPromise,

        /**
         * Updates settings in the Service Worker.
         * @param {object} newSettings - An object with settings to update (e.g., { proxyUrl: '...', requestTimeoutMs: 20000 }).
         */
        updateSettings: (newSettings) => {
             // ... (same logic as before) ...
             if (typeof newSettings !== 'object' || newSettings === null) { onErrorCallback('VDomain: updateSettings expects an object.'); return; }
             currentSwSettings = { ...currentSwSettings, ...newSettings };
             if (!isReady) { onLogCallback('VDomain: Stored settings update. Will send when SW is ready.'); return; }
             onLogCallback(`VDomain: Sending settings update to SW:`, newSettings);
             VDomain._postMessage({ type: 'UPDATE_SETTINGS', payload: newSettings });
        },

        /**
         * Manually triggers a check and potential update for specific paths in the SW cache.
         * Useful after external file system changes if not automatically detected.
         * Note: SW normally pulls updates via ASK_FILE_STATUS on fetch. This is for explicit pushes.
         * @param {string[]} paths - Array of paths to potentially update in the SW.
         */
        async triggerCacheUpdate(paths) {
            if (!isReady) {
                onErrorCallback('VDomain: Cannot trigger cache update, SW not ready.');
                return;
            }
             if (!fileSystemAdapter) {
                 onErrorCallback('VDomain: Cannot trigger cache update, no IFileSystem adapter configured.');
                 return;
             }
             if (!Array.isArray(paths)) {
                 onErrorCallback('VDomain: triggerCacheUpdate expects an array of paths.');
                 return;
             }

            onLogCallback('VDomain: Manually triggering cache update check for paths:', paths);
            const filesToUpdate = {};
            let updateCount = 0;

            for (const path of paths) {
                const resolvedPath = defaultFilePathResolver(path) || path;
                try {
                    if (await fileSystemAdapter.exists(resolvedPath)) {
                        const meta = await fileSystemAdapter.getMetadata(resolvedPath);
                        if (meta.type === 'file') {
                            const blobContent = await fileSystemAdapter.readFile(resolvedPath);
                            filesToUpdate[path] = { // Use original path as key for SW
                                content: blobContent, // Send Blob
                                mimeType: determineMimeType(resolvedPath, blobContent),
                                lastModified: meta.modifiedAt.getTime()
                            };
                            updateCount++;
                        }
                    } else {
                         // Signal deletion to SW by sending null for the path
                         filesToUpdate[path] = null;
                         updateCount++;
                    }
                } catch (error) {
                    onErrorCallback(`VDomain: Error getting data for path '${resolvedPath}' during triggerCacheUpdate:`, error);
                    // Don't include this file in the update message
                }
            }

            if (updateCount > 0) {
                onLogCallback(`VDomain: Sending ${updateCount} file updates/deletions to SW based on trigger.`);
                // Send using the existing UPDATE_FILES message type, SW needs to handle Blobs and nulls
                VDomain._postMessage({ type: 'UPDATE_FILES', payload: filesToUpdate });
            } else {
                 onLogCallback('VDomain: No updates needed based on triggered check.');
            }
        },


        reloadPreview: () => { /* ... (same as before) ... */ },

        // --- Internal Methods ---
        _postMessage: (messagePayload) => {
             // ... (same logic as before) ...
             if (!iframeElement || !iframeElement.contentWindow) { onErrorCallback('VDomain: Cannot send message, iframe not available.'); return; }
             const loaderMessage = { type: 'SP_MSG', payload: messagePayload };
             iframeElement.contentWindow.postMessage(loaderMessage, previewOrigin);
        },

        _sendFileStatusResponse: (requestId, action, fileData) => {
             // IMPORTANT: SW expects 'content' to be string or ArrayBuffer usually.
             // If sending Blob, SW's handleFileStatusResponse needs adjustment.
             // Let's adjust it here to send text/ArrayBuffer for simplicity with current SW.
             const messagePayload = {
                 type: 'FILE_STATUS_RESPONSE',
                 payload: { requestId, action, fileData: { path: fileData.path } } // Start with basic info
             };

             if (action === 'UPDATE_AND_SERVE' && fileData.content instanceof Blob) {
                 // Need to read the Blob content before sending
                 const readerPromise = fileData.mimeType && fileData.mimeType.startsWith('text/')
                     ? fileData.content.text() // Read as text if likely text
                     : fileData.content.arrayBuffer(); // Otherwise read as ArrayBuffer

                 readerPromise.then(contentData => {
                     messagePayload.payload.fileData = {
                         path: fileData.path,
                         content: contentData, // Now string or ArrayBuffer
                         mimeType: fileData.mimeType,
                         lastModified: fileData.lastModified
                     };
                     VDomain._postMessage(messagePayload);
                 }).catch(err => {
                      onErrorCallback(`VDomain: Failed to read Blob content for path ${fileData.path}`, err);
                      // Send FILE_NOT_FOUND as fallback
                      VDomain._sendFileStatusResponse(requestId, 'FILE_NOT_FOUND', { path: fileData.path });
                  });
             } else if (action === 'UPDATE_AND_SERVE') {
                  // If content wasn't a Blob (e.g., already string/buffer from a different adapter logic)
                  messagePayload.payload.fileData = fileData;
                  VDomain._postMessage(messagePayload);
             }
             else {
                 // For USE_CACHED or FILE_NOT_FOUND, just send the path info
                 VDomain._postMessage(messagePayload);
             }
        },
        _sendProxyResponse: (requestId, allowed) => {
            VDomain._postMessage({ type: 'PROXY_RESPONSE', payload: { requestId, allowed } });
        }
    };

    // --- Helper Functions ---
    function determineMimeType(filePath, blobContent) {
        // Basic MIME type detection based on extension (improve as needed)
        const extension = filePath.split('.').pop().toLowerCase();
        switch (extension) {
            case 'html': case 'htm': return 'text/html';
            case 'css': return 'text/css';
            case 'js': case 'mjs': return 'application/javascript';
            case 'json': return 'application/json';
            case 'png': return 'image/png';
            case 'jpg': case 'jpeg': return 'image/jpeg';
            case 'gif': return 'image/gif';
            case 'svg': return 'image/svg+xml';
            case 'txt': return 'text/plain';
            // Add more types...
            default:
                // Fallback: Try using Blob's type if available, otherwise octet-stream
                return blobContent?.type || 'application/octet-stream';
        }
    }


    window.VDomain = VDomain;

})();