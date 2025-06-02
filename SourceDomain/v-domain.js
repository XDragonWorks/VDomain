(() => {
    // --- Library State ---
    let iframeElement = null;
    let previewOrigin = null;
    let serviceWorkerPort = null; // Holds the MessagePort connected to the SW
    let isReady = false; // True when SW Port is received and ready
    let fileSystemAdapter = null; // Holds the IFileSystem adapter instance
    let defaultFilePathResolver = (path) => (path === '/' || path.endsWith('/')) ? '/index.html' : null; // Default file logic
    // Callback functions
    let onRequestFile = null;
    let onLogCallback = console.log;
    let onErrorCallback = console.error;
    let onRequestProxyPermissionCallback = defaultRequestProxyPermissionHandler; // User confirmation for proxy
    // Readiness promise
    let readyPromise = null;
    let readyPromiseResolve = null;
    let readyPromiseReject = null; // For handling init errors
    // Current settings sent to SW
    let currentSwSettings = {};

    let isHeartBeatTimeout = false;


    // --- Default Handlers ---

    // Default UI handler for proxy permission requests using window.confirm
    function defaultRequestProxyPermissionHandler(requestId, requestDetails) {
        const { url, method, headers } = requestDetails;
        // Create a user-friendly message
        const headerString = Object.entries(headers || {})
            .map(([key, value]) => `  ${key}: ${value}`)
            .filter(([key]) => !key.toLowerCase().startsWith('sec-') && key.toLowerCase() !== 'host') // Filter some noise
            .join('\n');
        const confirmationMessage = `The preview environment wants to make a '${method}' request to an external URL:\n\n${url}\n\n${headerString ? 'Headers:\n' + headerString + '\n' : ''}\nAllow this request? (It will be routed through the configured proxy)`;

        try {
            // Use try-catch in case window.confirm is blocked or fails
            const allowed = window.confirm(confirmationMessage);
            onLogCallback(`VDomain: Proxy permission for ${url}: ${allowed ? 'Granted' : 'Denied'}`);
            VDomain._sendProxyResponse(requestId, allowed); // Send response back to SW
        } catch (error) {
            onErrorCallback(`VDomain: Error during proxy confirmation UI for ${url}:`, error);
            // Deny if the UI fails
            VDomain._sendProxyResponse(requestId, false);
        }
    }

    // --- Internal File Status Handler (using IFileSystem) ---
    // This function is called when the SW asks for the status of a file.
    async function internalRequestFileStatusHandler(requestId, requestedPath, cachedMetadata) {
        // Ensure an IFileSystem adapter has been provided during init
        if (!fileSystemAdapter) {
            onErrorCallback(`VDomain: Received file status request for '${requestedPath}' but no IFileSystem adapter is configured.`);
            // Tell SW the file is not found if no adapter exists
            VDomain._sendFileStatusResponse(requestId, 'FILE_NOT_FOUND', { path: requestedPath });
            return;
        }

        onLogCallback(`VDomain: Received file status request for '${requestedPath}', cached modified (SW): ${cachedMetadata?.lastModified}`);

        // Apply the default file resolution logic (e.g., '/' -> '/index.html')
        const resolvedPath = defaultFilePathResolver(requestedPath) || requestedPath;
        if (resolvedPath !== requestedPath) {
            onLogCallback(`VDomain: Resolved requested path '${requestedPath}' to default file path '${resolvedPath}'`);
        }

        try {
            // 1. Check if the resolved path exists in the provided file system
            const exists = await fileSystemAdapter.exists(resolvedPath);

            if (!exists) {
                // File/Directory does not exist in the source filesystem
                onLogCallback(`VDomain: Path '${resolvedPath}' (resolved from '${requestedPath}') not found in IFileSystem adapter '${fileSystemAdapter.adapterName}'.`);
                VDomain._sendFileStatusResponse(requestId, 'FILE_NOT_FOUND', { path: requestedPath }); // Respond to SW with original path
                return;
            }

            // 2. Get metadata (type, size, modifiedAt) from the file system
            const fsMetadata = await fileSystemAdapter.getMetadata(resolvedPath);

            // 3. Ensure the path points to a file, not a directory
            if (fsMetadata.type !== 'file') {
                onErrorCallback(`VDomain: Path '${resolvedPath}' exists but is a directory, not a file, in adapter '${fileSystemAdapter.adapterName}'.`);
                // SW expects a file for this request, so treat directory as not found
                VDomain._sendFileStatusResponse(requestId, 'FILE_NOT_FOUND', { path: requestedPath });
                return;
            }

            // 4. Get the last modified timestamp from the file system metadata
            const fsLastModified = fsMetadata.modifiedAt.getTime(); // Get timestamp in milliseconds
            onLogCallback(`VDomain: File '${resolvedPath}' found in IFileSystem. Last Modified (FS): ${fsLastModified}`);

            // 5. Compare file system timestamp with the SW cache timestamp (if provided)
            if (cachedMetadata && cachedMetadata.lastModified && cachedMetadata.lastModified >= fsLastModified) {
                // SW cache is up-to-date or potentially newer (allow newer)
                onLogCallback(`VDomain: SW cache for '${requestedPath}' is up-to-date.`);
                // Tell SW to use its cached version
                VDomain._sendFileStatusResponse(requestId, 'USE_CACHED', { path: requestedPath });
            } else {
                // SW cache is outdated, doesn't exist, or FS timestamp is unreliable
                onLogCallback(`VDomain: SW cache for '${requestedPath}' needs update or initial load.`);
                // Read the file content as a Blob from the file system
                let blobContent = await fileSystemAdapter.readFile(resolvedPath);
                // Determine a suitable MIME type based on path or Blob type
                const mimeType = determineMimeType(resolvedPath, blobContent);

                // 如果有修改器的话
                if (onRequestFile){
                    blobContent = await onRequestFile(resolvedPath, blobContent) ?? blobContent;
                }

                // Tell SW to update its cache and serve this new content
                VDomain._sendFileStatusResponse(requestId, 'UPDATE_AND_SERVE', {
                    path: requestedPath, // Respond with the path SW originally asked for
                    content: blobContent, // Send the Blob content
                    mimeType: mimeType,
                    lastModified: fsLastModified // Send the current modification timestamp
                });
            }

        } catch (error) {
            // Handle potential errors during file system operations
            onErrorCallback(`VDomain: Error handling file status for '${requestedPath}' using IFileSystem adapter '${fileSystemAdapter?.adapterName || 'N/A'}':`, error);
            // Check for specific IFileSystem error types if needed
            // if (error instanceof PathNotFoundError) { ... }
            // For most errors, tell SW the file wasn't found as a safe fallback
            VDomain._sendFileStatusResponse(requestId, 'FILE_NOT_FOUND', { path: requestedPath });
        }
    }


    // --- Message Listener (Handles initial Port message from Loader) ---
    function handleIncomingMessage(event) {

        const message = event.data;
        // Ensure message has expected structure
        if (!message || typeof message !== 'object') return;

        // Check for the specific message from __loader.html containing the MessagePort
        if (message.type === 'LOADER_READY_WITH_PORT' && event.ports && event.ports.length > 0) {
            onLogCallback('VDomain: Received Message Port from Loader.');

            // If already initialized, potentially close old port? Or log warning.
            if (serviceWorkerPort) {
                console.warn("VDomain: Received new port, closing previous one.");
                serviceWorkerPort.close();
            }

            serviceWorkerPort = event.ports[0]; // Store the port for communication

            // Start listening for messages coming FROM the Service Worker ON THIS PORT
            serviceWorkerPort.onmessage = (portEvent) => {
                handleSwMessage(portEvent.data); // Pass SW messages to dedicated handler
            };

            // Handle potential errors on the port
            serviceWorkerPort.onmessageerror = (error) => {
                onErrorCallback("VDomain: Error receiving message on SW port:", error);
            };

            // (Optional but good practice) Explicitly start the port if needed by the browser
            // serviceWorkerPort.start();

            // Send any initial settings that were configured before the port was ready
            if (Object.keys(currentSwSettings).length > 0) {
                VDomain.updateSettings(currentSwSettings);
            }

            // Resolve the readiness promise now that the port is set up
            // We wait for SW_PORT_READY confirmation for full readiness
            // if (readyPromiseResolve) {
            //     readyPromiseResolve();
            //     readyPromiseResolve = null;
            // }

            return; // Port initialization message handled
        }

        // Handle error messages sent by the loader page itself
        if (message.type === 'LOADER_ERROR') {
            onErrorCallback('VDomain: Error reported directly by Loader page:', message.error);
            // Reject the initialization promise if it's still pending
            if (readyPromiseReject) {
                readyPromiseReject(new Error(`Loader Error: ${message.error}`));
                readyPromiseResolve = null; // Prevent resolving later
                readyPromiseReject = null;
            }
            isReady = false; // Ensure not marked as ready
            return;
        }

        // Log other unexpected messages received on the main window listener
        // console.warn("VDomain: Received unexpected message on window listener:", message);
    }

    // --- SW Message Handler (Handles messages received via MessagePort) ---
    function handleSwMessage(payload) {
        // Ensure payload structure
        if (!payload || typeof payload !== 'object') {
            onErrorCallback('VDomain: Received invalid message payload from SW via Port:', payload);
            return;
        }
        // Log received message (optional)
        onLogCallback('VDomain: Received message from SW via Port:', payload.type, payload.payload);

        // 有新消息自动重置
        isHeartBeatTimeout = false;

        switch (payload.type) {
            case 'SW_PORT_READY': // SW confirms it's ready and listening on its end of the port
                onLogCallback('VDomain: Service Worker confirmed Port readiness.');
                if (!isReady) { // Resolve the main readiness promise only once
                    isReady = true;
                    if (readyPromiseResolve) {
                        readyPromiseResolve();
                        readyPromiseResolve = null; // Clear resolver
                        readyPromiseReject = null;  // Clear rejecter
                    }
                }
                // Optionally trigger initial navigation now
                // VDomain.navigate('/');
                break;
            case 'ASK_FILE_STATUS': // SW is asking about a file
                if (payload.payload) {
                    // Delegate to the internal handler using IFileSystem
                    internalRequestFileStatusHandler(
                        payload.payload.requestId,
                        payload.payload.path,
                        payload.payload.cachedMetadata
                    );
                } else {
                    onErrorCallback('VDomain: Invalid payload for ASK_FILE_STATUS:', payload);
                }
                break;
            case 'ASK_PROXY_PERMISSION': // SW is asking permission for an external request
                if (onRequestProxyPermissionCallback && payload.payload) {
                    // Call the user-provided or default handler for UI confirmation
                    onRequestProxyPermissionCallback(
                        payload.payload.requestId,
                        payload.payload.requestDetails
                    );
                } else if (!onRequestProxyPermissionCallback) {
                    onErrorCallback("VDomain: Received ASK_PROXY_PERMISSION but no handler is configured.");
                    // Deny by default if no handler
                    VDomain._sendProxyResponse(payload.payload.requestId, false);
                } else {
                    onErrorCallback('VDomain: Invalid payload for ASK_PROXY_PERMISSION:', payload);
                }
                break;
            case 'LOG': // SW sending log messages to IDE console
                onLogCallback('VDomain (SW Log):', payload.payload);
                break;
            case 'ERROR': // SW sending error messages to IDE console
                onErrorCallback('VDomain (SW Error):', payload.payload);
                break;
            case 'HEART_BEAT':
                lastHeartBeatTime = Date.now();
                break;
            default:
                console.warn('VDomain: Received unknown message type from SW via Port:', payload.type);
        }
    }

    // 心跳包
    const HeartBeatInterval = 5000;
    const HeartBeatTimeout = 10000;
    let lastHeartBeatTime = null;
    function initHeartBeat(){
        setInterval(() => {
            if (!serviceWorkerPort) return;
            VDomain._postMessage({ type: "HEART_BEAT" });

            // 超时
            if (Date.now() - lastHeartBeatTime > HeartBeatTimeout){
                isHeartBeatTimeout = true;
                console.warn('VDomain: Heart Beat Timeout');
            }
        }, HeartBeatInterval);
    }


    // --- Public API ---
    const VDomain = {
        /**
         * Initializes the VDomain library. Establishes communication with the preview SW.
         * @param {object} options
         * @param {string|HTMLIFrameElement} options.iframeSelector - CSS Selector string or the iframe DOM element for the preview.
         * @param {string} options.previewOrigin - The origin of the preview domain (e.g., 'https://a.example.com'). Must match the domain serving __loader.html.
         * @param {IFileSystem} options.fileSystemAdapter - An initialized instance of your IFileSystem implementation (e.g., new IndexedDBFileSystemAdapter('myFS')).
         * @param {function} [options.defaultFilePathResolver] - Optional function: (requestedPath: string) => defaultPath: string | null. Defaults to mapping '/' or dir/ to '/index.html'.
         * @param {object} [options.initialSettings] - Optional initial settings for the SW (e.g., { proxyUrl: '...', requestTimeoutMs: 10000 }).
         * @param {function} [options.onRequestFile] - Optional file modificator
         * @param {function} [options.onLog] - Optional logging callback. Defaults to console.log.
         * @param {function} [options.onError] - Optional error callback. Defaults to console.error.
         * @param {function} [options.onRequestProxyPermission] - Optional callback(requestId, requestDetails) to handle proxy permission UI. Defaults to window.confirm.
         * @returns {Promise<void>} A promise that resolves when the communication channel with the SW is established and ready, or rejects on fatal initialization errors.
         */
        init: (options) => {

            // --- Input Validation ---
            if (!options || typeof options !== 'object') {
                throw new Error("VDomain.init: Options object is required.");
            }
            if (!options.iframeSelector) {
                throw new Error("VDomain.init: 'iframeSelector' option is required.");
            }
            if (!options.previewOrigin || typeof options.previewOrigin !== 'string') {
                throw new Error("VDomain.init: 'previewOrigin' option (string) is required.");
            }
            // Validate IFileSystem adapter duck-typing essential methods
            if (!options.fileSystemAdapter ||
                typeof options.fileSystemAdapter.readFile !== 'function' ||
                typeof options.fileSystemAdapter.exists !== 'function' ||
                typeof options.fileSystemAdapter.getMetadata !== 'function' ||
                typeof options.fileSystemAdapter.adapterName !== 'string') {
                if (options.fileSystemAdapter === -1) {
                    console.warn("VDomain.init: init without 'fileSystemAdapter', this may cause errors.")
                } else {
                    throw new Error("VDomain.init: requires a valid 'fileSystemAdapter' implementing the IFileSystem interface (readFile, exists, getMetadata, adapterName).");
                }

            }

            // --- Find Iframe Element ---
            if (typeof options.iframeSelector === 'string') {
                iframeElement = document.querySelector(options.iframeSelector);
                if (!iframeElement) {
                    throw new Error(`VDomain.init: Could not find iframe element with selector "${options.iframeSelector}".`);
                }
            } else if (options.iframeSelector instanceof HTMLIFrameElement) {
                iframeElement = options.iframeSelector;
            } else {
                throw new Error("VDomain.init: 'iframeSelector' must be a CSS selector string or an HTMLIFrameElement.");
            }


            // --- Store Configuration ---
            previewOrigin = options.previewOrigin;
            fileSystemAdapter = options.fileSystemAdapter;
            defaultFilePathResolver = options.defaultFilePathResolver || ((path) => (path === '/' || path.endsWith('/')) ? '/index.html' : null);
            currentSwSettings = options.initialSettings || {};
            onRequestFile = options.onRequestFile;
            onLogCallback = options.onLog || console.log;
            onErrorCallback = options.onError || console.error;
            // Use provided proxy handler or the default window.confirm one
            onRequestProxyPermissionCallback = options.onRequestProxyPermission || defaultRequestProxyPermissionHandler;

            // --- Reset State for Re-initialization ---
            isReady = false;
            if (serviceWorkerPort) {
                serviceWorkerPort.close(); // Close previous port if exists
                serviceWorkerPort = null;
            }
            // Create a new promise for this initialization attempt
            readyPromise = new Promise((resolve, reject) => {
                readyPromiseResolve = resolve;
                readyPromiseReject = reject;
            });

            // --- Setup Listener for Loader ---
            // Remove previous listener if any
            window.removeEventListener('message', handleIncomingMessage);
            // Add the listener to catch the message with the port from the loader
            window.addEventListener('message', handleIncomingMessage);

            onLogCallback(`VDomain: Initialized with IFileSystem adapter '${fileSystemAdapter.adapterName}'. Waiting for Loader to provide Message Port...`);

            // --- Trigger Loader ---
            // Reload the iframe to ensure the __loader.html script runs and establishes the connection
            if (!VDomain.isReady()) {
                onLogCallback('VDomain: Reloading preview iframe to start loader...');
                // Construct loader URL safely
                try {
                    const loaderUrl = new URL('/__loader.html', previewOrigin);
                    iframeElement.src = loaderUrl.href;
                } catch (e) {
                    onErrorCallback("VDomain: Invalid previewOrigin provided:", previewOrigin, e);
                    if (readyPromiseReject) readyPromiseReject(new Error("Invalid previewOrigin"));
                    return readyPromise; // Return the rejected promise
                }
            } else {
                const errMsg = 'VDomain: Cannot reload iframe during init (iframe contentWindow is not accessible).';
                onErrorCallback(errMsg);
                if (readyPromiseReject) readyPromiseReject(new Error("Iframe not accessible"));
                return readyPromise; // Return the rejected promise
            }

            // 开始检测
            initHeartBeat();

            // Return the promise that will resolve/reject based on the handshake process
            return readyPromise;
        },

        /**
         * Checks if the communication channel with the Service Worker is established and ready.
         * @returns {boolean} True if ready, false otherwise.
         */
        isReady: () => isReady && serviceWorkerPort !== null,

        /**
         * Returns a promise that resolves when the VDomain instance is fully initialized and ready for communication.
         * Useful if you need to ensure readiness before performing actions.
         * @returns {Promise<void>}
         */
        whenReady: () => readyPromise,

        /**
         * Updates settings in the Service Worker (e.g., proxy URL, timeout).
         * @param {object} newSettings - An object containing key-value pairs of settings to update.
         */
        updateSettings: (newSettings) => {
            if (typeof newSettings !== 'object' || newSettings === null) {
                onErrorCallback('VDomain: updateSettings expects an object.');
                return;
            }
            // Merge new settings into the current local settings
            currentSwSettings = { ...currentSwSettings, ...newSettings };

            // Only send if the communication channel is ready
            if (!VDomain.isReady()) {
                onLogCallback('VDomain: Stored settings update. Will send when Port is ready.');
                return;
            }
            onLogCallback(`VDomain: Sending settings update to SW via Port:`, newSettings);
            VDomain._postMessage({ type: 'UPDATE_SETTINGS', payload: newSettings });
        },

        updatePreviewOrigin: (newOrigin) => {
            previewOrigin = newOrigin;
        },

        /**
         * Set a new file system
         * @param {object} newFileSystemAdaptor - The new IFileSystem adaptor.
         */
        setFileSystemAdaptor: (newFileSystemAdaptor) => {
            if (!newFileSystemAdaptor ||
                typeof newFileSystemAdaptor.readFile !== 'function' ||
                typeof newFileSystemAdaptor.exists !== 'function' ||
                typeof newFileSystemAdaptor.getMetadata !== 'function' ||
                typeof newFileSystemAdaptor.adapterName !== 'string') {
                throw new Error("VDomain: requires a valid 'fileSystemAdapter' implementing the IFileSystem interface (readFile, exists, getMetadata, adapterName).");
            }

            fileSystemAdapter = newFileSystemAdaptor;
        },

        /**
         * Manually triggers the Service Worker to check and potentially update its cache
         * for a specific list of paths based on the current state in the IFileSystem.
         * This is useful if the underlying file system changes externally.
         * @param {string[]} paths - An array of absolute paths (e.g., ['/index.html', '/styles/main.css']) to check and potentially update.
         */
        async triggerCacheUpdate(paths) {
            // Ensure communication is ready and adapter exists
            if (!VDomain.isReady()) { onErrorCallback('VDomain: Cannot trigger cache update, Port not ready.'); return; }
            if (!fileSystemAdapter) { onErrorCallback('VDomain: Cannot trigger cache update, no IFileSystem adapter configured.'); return; }
            if (!Array.isArray(paths)) { onErrorCallback('VDomain: triggerCacheUpdate expects an array of paths.'); return; }
            if (paths.length === 0) { onLogCallback('VDomain: triggerCacheUpdate called with empty paths array.'); return; }


            onLogCallback('VDomain: Manually triggering cache update check for paths:', paths);
            const filesToUpdatePayload = {}; // Payload for the SW message
            let operationCount = 0; // Count files to update/delete

            // Iterate through requested paths and check against the file system
            for (const path of paths) {
                // Normalize path (ensure leading slash) - Adapters should handle internal normalization too
                const normalizedPath = path.startsWith('/') ? path : '/' + path;
                const resolvedPath = defaultFilePathResolver(normalizedPath) || normalizedPath; // Apply default resolution

                try {
                    // Check existence in the file system
                    if (await fileSystemAdapter.exists(resolvedPath)) {
                        const meta = await fileSystemAdapter.getMetadata(resolvedPath);
                        // We only care about updating files
                        if (meta.type === 'file') {
                            // Read file content as Blob
                            let blobContent = await fileSystemAdapter.readFile(resolvedPath);
                            // Add to payload using the *original* path SW might request
                            filesToUpdatePayload[normalizedPath] = {
                                content: blobContent, // Send Blob directly
                                mimeType: determineMimeType(resolvedPath, blobContent),
                                lastModified: meta.modifiedAt.getTime()
                            };
                            operationCount++;
                        } else {
                            onLogCallback(`VDomain: Path '${resolvedPath}' is a directory, skipping update trigger for '${normalizedPath}'.`);
                        }
                    } else {
                        // If file doesn't exist in FS, tell SW to remove it from cache
                        filesToUpdatePayload[normalizedPath] = null; // null signifies deletion
                        operationCount++;
                    }
                } catch (error) {
                    onErrorCallback(`VDomain: Error getting data for path '${resolvedPath}' during triggerCacheUpdate for '${normalizedPath}':`, error);
                    // Skip this path on error
                }
            }

            // Send the update message to SW if there's anything to update/delete
            if (operationCount > 0) {
                onLogCallback(`VDomain: Sending ${operationCount} file updates/deletions to SW based on trigger.`);
                VDomain._postMessage({ type: 'UPDATE_FILES', payload: filesToUpdatePayload });
            } else {
                onLogCallback('VDomain: No cache updates needed based on triggered check.');
            }
        },

        /**
         * Instructs the Service Worker to navigate the preview iframe to the specified URL.
         * The URL should be an absolute path within the preview origin (e.g., '/about', '/users/profile').
         * @param {string} url - The absolute path URL to navigate to.
         */
        navigate: (url) => {
            if (!VDomain.isReady()) { onErrorCallback('VDomain: Cannot navigate, Port not ready.'); return; }
            if (typeof url !== 'string' || !url.startsWith('/')) {
                onErrorCallback('VDomain: Navigation URL must be a string starting with /. Example: "/about/contact".');
                return;
            }
            onLogCallback(`VDomain: Sending NAVIGATE command to SW for url: ${url}`);
            VDomain._postMessage({ type: 'NAVIGATE', payload: url });
        },

        /**
         * Reloads the preview environment. It's often better to use navigate('/') for a smoother experience
         * if the SW correctly handles root navigation. Direct reload might cause brief connection issues.
         */
        reloadPreview: () => {
            if (iframeElement && iframeElement.contentWindow) {
                onLogCallback('VDomain: Requesting preview reload (using navigate("/"))');
                // Prefer asking SW to navigate to root, assuming it serves index.html
                VDomain.navigate('/');
                // Fallback: Direct reload (use with caution)
                // iframeElement.contentWindow.location.reload();
            } else {
                onErrorCallback('VDomain: Cannot reload, iframe not accessible.');
            }
        },

        // --- Internal Methods ---

        /**
         * Sends a message payload to the Service Worker via the established MessagePort.
         * @private Internal use only.
         * @param {object} messagePayload - The payload object { type: string, payload: any }.
         */
        _postMessage: (messagePayload) => {
            if (!serviceWorkerPort) {
                onErrorCallback('VDomain: Cannot send message, Service Worker port not available.');
                // Maybe queue the message or throw an error?
                return;
            }
            try {
                // Debug log (can be noisy)
                // onLogCallback('VDomain: Sending message to SW via Port:', messagePayload.type);
                serviceWorkerPort.postMessage(messagePayload);
            } catch (error) {
                onErrorCallback('VDomain: Error posting message via SW port:', error);
                // Consider the port broken?
                // isReady = false; serviceWorkerPort = null;
                // if (readyPromiseReject) readyPromiseReject(error); // Reject if init promise still pending
            }
        },

        /**
         * Prepares and sends the response to the SW's ASK_FILE_STATUS request.
         * Handles converting Blob content to a format suitable for postMessage if needed,
         * although current SW version is designed to handle Blob directly in UPDATE_AND_SERVE.
         * @private Internal use only.
         */
        _sendFileStatusResponse: (requestId, action, fileData) => {
            // Base message structure
            const messagePayload = {
                type: 'FILE_STATUS_RESPONSE',
                payload: {
                    requestId,
                    action,
                    fileData: { path: fileData.path } // Always include the path SW asked for
                }
            };

            // If serving updated content, include all necessary details
            if (action === 'UPDATE_AND_SERVE') {
                if (fileData.content !== undefined && fileData.lastModified !== undefined) {
                    // SW now handles Blob, so just pass required fields
                    messagePayload.payload.fileData = {
                        path: fileData.path,
                        content: fileData.content, // Send Blob/ArrayBuffer/string
                        mimeType: fileData.mimeType,
                        lastModified: fileData.lastModified
                    };
                    VDomain._postMessage(messagePayload);
                } else {
                    onErrorCallback(`VDomain: Missing content or lastModified for UPDATE_AND_SERVE response for path ${fileData.path}`);
                    // Send FILE_NOT_FOUND as fallback if data is incomplete
                    VDomain._sendFileStatusResponse(requestId, 'FILE_NOT_FOUND', { path: fileData.path });
                }
            } else {
                // For USE_CACHED or FILE_NOT_FOUND, only path is needed in fileData
                VDomain._postMessage(messagePayload);
            }
        },

        /**
         * Sends the response (allow/deny) to the SW's ASK_PROXY_PERMISSION request.
         * @private Internal use only.
         */
        _sendProxyResponse: (requestId, allowed) => {
            // Ensure allowed is boolean
            const permission = !!allowed;
            VDomain._postMessage({
                type: 'PROXY_RESPONSE',
                payload: { requestId, allowed: permission }
            });
        }
    };

    // --- Helper Functions ---

    /**
     * Determines a MIME type based on file extension or Blob type.
     * @param {string} filePath - The file path.
     * @param {Blob} [blobContent] - Optional Blob content to check its type property.
     * @returns {string} The guessed MIME type.
     */
    function determineMimeType(filePath, blobContent) {
        const extension = filePath.includes('.') ? filePath.split('.').pop().toLowerCase() : '';
        switch (extension) {
            case 'html': case 'htm': return 'text/html; charset=utf-8';
            case 'css': return 'text/css; charset=utf-8';
            case 'js': case 'mjs': return 'application/javascript; charset=utf-8';
            case 'json': return 'application/json; charset=utf-8';
            case 'xml': return 'application/xml; charset=utf-8';
            case 'png': return 'image/png';
            case 'jpg': case 'jpeg': return 'image/jpeg';
            case 'gif': return 'image/gif';
            case 'svg': return 'image/svg+xml';
            case 'webp': return 'image/webp';
            case 'ico': return 'image/x-icon';
            case 'woff': return 'font/woff';
            case 'woff2': return 'font/woff2';
            case 'ttf': return 'font/ttf';
            case 'otf': return 'font/otf';
            case 'txt': return 'text/plain; charset=utf-8';
            case 'md': return 'text/markdown; charset=utf-8';
            // Add more common types as needed
            default:
                // If no extension match, try the Blob's reported type (if available)
                if (blobContent && blobContent.type && blobContent.type !== 'application/octet-stream') {
                    return blobContent.type;
                }
                // Ultimate fallback
                return 'application/octet-stream';
        }
    }


    // --- Expose Library ---
    // Assign the public API to the window object (or export if using modules)
    window.VDomain = VDomain;

})();