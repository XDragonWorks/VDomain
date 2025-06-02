// --- 配置与状态 ---
let swSettings = {
    proxyUrl: null,
    addCors: false,
    requestTimeoutMs: 15000, // 默认超时时间 15 秒
    virtualCacheName: 'v-domain-default',
    autoReloadOnDisconnect: true,
};
const PENDING_FILE_REQUESTS = new Map(); // { requestId: { resolve, reject, timer } }
const PENDING_PROXY_REQUESTS = new Map(); // { requestId: { resolve, reject, timer } }
let idePort = null; // !! Stores the MessagePort connected to the IDE !!

// --- 唯一 ID 生成器 ---
let requestIdCounter = 0;
function generateRequestId() {
    return `req-${Date.now()}-${requestIdCounter++}`;
}

console.log('SW: Script evaluating');

// --- 生命周期事件 ---
self.addEventListener('install', event => {
    console.log('SW: Install');
    event.waitUntil(async () => {
        console.log(`SW: Trying to load settings from IndexDB`)
        try {
            await openDB();
            await loadConfig();
            console.log(`SW: Settings loaded.`)
        } catch (e) {
            console.error(`SW: Unable to load settings from IndexDB: `, e)
        }
        return;
    });
});

self.addEventListener('activate', event => {
    console.log('SW: Activate');
    initHeartBeat();
});

// --- 消息处理 (主要监听 Port 初始化) ---
self.addEventListener('message', event => {
    // 监听来自 Loader 页面的初始端口消息
    if (event.data && event.data.type === 'INIT_PORT' && event.ports && event.ports.length > 0) {
        console.log('SW: Received INIT_PORT message.');
        if (idePort) {
            console.warn('SW: Received INIT_PORT again, closing previous port.');
            idePort.close(); // 关闭旧端口（如果存在）
        }
        idePort = event.ports[0]; // 保存新的端口
        console.log('SW: IDE communication port established.');

        (async () => {
            console.log('SW: Port established, try to take over controll the domain.');
            await self.skipWaiting()
            console.log('SW: Skipped waiting.');
            await self.clients.claim()
            console.log('SW: Claimed clients.');
        })();

        // 在这个新端口上设置消息监听器，接收来自 IDE 的指令
        idePort.onmessage = (portEvent) => {
            // 确保数据格式符合预期
            if (!portEvent.data || typeof portEvent.data !== 'object') {
                console.warn('SW: Received invalid message format from IDE via Port:', portEvent.data);
                return;
            }
            const { type, payload } = portEvent.data; // VDomain.js 发送 { type, payload }
            console.log('SW: Received message from IDE via Port:', type, payload);

            isHeartBeatTimeout = false;

            // 处理来自 IDE 的指令
            switch (type) {
                case 'UPDATE_SETTINGS':

                    if (payload && typeof payload === 'object') {
                        // 安全地合并设置，避免覆盖所有内容
                        swSettings = { ...swSettings, ...payload };
                        console.log('SW: Settings updated:', swSettings);

                        // 保存设置到本地
                        saveConfig();

                        // 清除旧缓存
                        console.log('SW: Cleaning old caches');
                        caches.keys().then(keys => Promise.all(
                            keys.filter(key => key !== swSettings.virtualCacheName)
                                .map(keyToDelete => caches.delete(keyToDelete))
                        ));

                    } else {
                        console.warn('SW: Invalid payload for UPDATE_SETTINGS:', payload);
                    }
                    break;
                case 'UPDATE_FILES': // 文件更新指令 (来自 triggerCacheUpdate)
                    handleUpdateFiles(payload); // 使用 Cache API 更新
                    break;
                case 'FILE_STATUS_RESPONSE': // IDE 对文件状态查询的响应
                    handleFileStatusResponse(payload);
                    break;
                case 'PROXY_RESPONSE': // IDE 对代理权限请求的响应
                    handleProxyResponse(payload);
                    break;
                case 'NAVIGATE': // IDE 请求导航预览窗口
                    if (payload && typeof payload === 'string') {
                        console.log(`SW: Received NAVIGATE command to: ${payload}`);
                        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
                            if (clients && clients.length > 0) {
                                // 导航第一个找到的窗口客户端
                                const clientToNavigate = clients[0];
                                console.log(`SW: Navigating client ${clientToNavigate.id} to ${payload}`);
                                clientToNavigate.navigate(payload).catch(err => {
                                    console.error('SW: Client navigation failed:', err);
                                    postMessageToIde({ type: 'ERROR', payload: `Navigation failed: ${err.message}` });
                                });
                            } else {
                                console.warn('SW: No client window found to navigate.');
                                postMessageToIde({ type: 'ERROR', payload: 'No preview window found to navigate.' });
                            }
                        });
                    } else {
                        console.warn('SW: Invalid payload for NAVIGATE:', payload);
                    }
                    break;
                case 'HEART_BEAT':
                    console.log('SW: Received Heart Beat');
                    lastHeartBeatTime = Date.now();
                    break;
                default:
                    console.warn('SW: Received unknown message type from IDE via Port:', type);
            }
        };

        // (可选) 可以在端口上监听错误或关闭事件
        idePort.onmessageerror = (error) => {
            console.error("SW: Error on IDE port message:", error);
        };
        // Note: 'close' event on MessagePort is not standard/reliable in SW.

        // 发送确认消息回 IDE，表明端口已设置并监听
        postMessageToIde({ type: 'SW_PORT_READY' });
        console.log('SW: Sent SW_PORT_READY confirmation to IDE.');

        return; // 初始化端口消息处理完毕
    }

    // 可以忽略其他非端口初始化消息，或添加其他逻辑
    // console.log('SW: Received non-port message on global listener (ignoring):', event.data);
});


// --- 网络请求拦截 ---
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    const request = event.request;

    if (url.pathname === "/__HeartBeat") {
        event.respondWith(new Response(null, { status: 200 }));
        return;
    }

    // 只处理 HTTP/HTTPS 请求 和 非内部请求
    if (!url.protocol.startsWith('http') || url.pathname.startsWith("/__")) {
        // console.log('SW: Ignoring non-http(s) request:', url.protocol);
        return; // 让浏览器默认处理 data:, blob:, etc.
    }

    console.log(`SW: Intercepting fetch for: ${url.href} (Method: ${request.method})`);

    // --- 1. 处理虚拟文件系统请求 (同源 GET) ---
    if (url.origin === self.location.origin && request.method === 'GET') {
        const path = url.pathname; // 直接使用请求的路径
        const requestId = generateRequestId();

        console.log(`SW: Handling virtual file request for path: ${path}`);

        // 使用 Promise 包装异步流程（查询缓存 -> 问 IDE -> 返回响应），并添加超时
        const responsePromise = new Promise((resolve, reject) => {
            // 设置超时定时器
            const timer = setTimeout(() => {
                reject(new Error(`Timeout waiting for IDE file status response for path: ${path}`));
                PENDING_FILE_REQUESTS.delete(requestId); // 超时后清理
            }, swSettings.requestTimeoutMs);

            // 将 resolve, reject 和 timer 存起来，等 IDE 回复时使用
            PENDING_FILE_REQUESTS.set(requestId, { resolve, reject, timer });

            // 查询 Cache API 中是否有缓存的响应
            caches.match(request, { cacheName: swSettings.virtualCacheName }).then(cachedResponse => {
                let lastModifiedHeader = null;
                if (cachedResponse) {
                    // 从自定义头获取上次修改时间戳
                    lastModifiedHeader = cachedResponse.headers.get('X-Last-Modified');
                }
                // 向 IDE 发送消息，询问文件状态，附带缓存信息
                postMessageToIde({
                    type: 'ASK_FILE_STATUS',
                    payload: {
                        requestId: requestId,
                        path: path, // 发送 SW 实际拦截到的路径
                        cachedMetadata: lastModifiedHeader ? { lastModified: parseInt(lastModifiedHeader, 10) } : null
                    }
                });
            }).catch(cacheError => {
                // 如果查询缓存本身失败
                console.error(`SW: Cache match failed for ${path}:`, cacheError);
                clearTimeout(timer); // 清除超时
                reject(new Error(`Cache storage error for ${path}: ${cacheError.message}`));
                PENDING_FILE_REQUESTS.delete(requestId); // 清理
            });
        });

        // 将 Promise 提供给 fetch 事件
        event.respondWith(
            responsePromise.catch(error => {
                console.error(`SW: Error handling file request for ${path}:`, error);
                // 根据错误类型生成合适的错误响应
                if (error.message.includes('Timeout')) {
                    return new Response(buildErrorPage('504 - Gateway Timeout waiting for file status', error.message, path, true), { status: 504, statusText: 'Gateway Timeout' });
                }
                return new Response(buildErrorPage('500 - Internal Server Error', error.message, path, true), { status: 500 });
            })
        );
        return; // fetch 事件已处理，结束
    }

    // --- 2. 处理代理请求 (所有非同源请求，或根据其他配置的规则) ---
    // 检查代理 URL 是否已配置
    if (swSettings.proxyUrl) {
        const requestId = generateRequestId();

        // 使用 Promise 包装异步流程（获取详情 -> 问 IDE 权限 -> 代理请求），并添加超时
        const proxyPromise = new Promise((resolve, reject) => {
            // 设置超时定时器
            const timer = setTimeout(() => {
                reject(new Error(`Timeout waiting for IDE proxy permission for: ${request.url}`));
                PENDING_PROXY_REQUESTS.delete(requestId); // 超时后清理
            }, swSettings.requestTimeoutMs);

            // 将 resolve, reject 和 timer 存起来，等 IDE 回复时使用
            PENDING_PROXY_REQUESTS.set(requestId, { resolve, reject, timer });

            // 异步获取请求的详细信息（包括 body）
            getRequestDetails(request).then(requestDetails => {
                // 向 IDE 发送消息，请求代理权限
                postMessageToIde({
                    type: 'ASK_PROXY_PERMISSION',
                    payload: {
                        requestId: requestId,
                        requestDetails: requestDetails // 包含 url, method, headers, body(可能编码)
                    }
                });
            }).catch(detailsError => {
                // 如果获取请求详情失败
                console.error(`SW: Failed to get request details for proxying ${request.url}:`, detailsError);
                clearTimeout(timer); // 清除超时
                reject(new Error(`Internal error preparing proxy request: ${detailsError.message}`));
                PENDING_PROXY_REQUESTS.delete(requestId); // 清理
            });
        })
            .then(allowed => { // 这个 then 链处理 IDE 返回的权限结果
                if (allowed) {
                    // 如果 IDE 允许
                    console.log(`SW: Proxy permission granted for request ID ${requestId}. Proceeding with proxy fetch.`);

                    // 是否走代理
                    if (swSettings.proxyUrl === 'none'){
                        return fetch(request);
                    }else {
                        return proxyFetchInSW(request);
                    }
                } else {
                    // 如果 IDE 拒绝
                    console.log(`SW: Proxy permission denied by IDE for request ID ${requestId}.`);
                    // 返回 403 Forbidden 响应
                    return new Response(buildErrorPage('403 - Forbidden', 'Request denied', null), { status: 403, statusText: 'Forbidden' });
                }
            });

        // 将 Promise 提供给 fetch 事件
        event.respondWith(
            proxyPromise.catch(error => {
                console.error(`SW: Error handling proxy request for ${request.url}:`, error);
                // 根据错误类型生成合适的错误响应
                if (error.message.includes('Timeout')) {
                    return new Response(buildErrorPage('504 - Gateway Timeout', 'Gateway Timeout waiting for proxy permission'), { status: 504, statusText: 'Gateway Timeout' });
                }
                if (error instanceof Response && error.status === 403) { // Forward 403 if denied
                    return error; // 直接返回 403 响应对象
                }
                if (error.message.includes('Internal error preparing')) {
                    return new Response(buildErrorPage('500 - Internal Server Error', error.message, path), { status: 500 });
                }
                // 其他代理执行错误 (来自 proxyFetchInSW) 或未知错误
                // proxyFetchInSW 内部会处理 AbortError 和网络错误，返回特定 Response
                // 如果错误不是 Response 对象，包装一下
                if (error instanceof Response) return error;
                return new Response(buildErrorPage('500 - Internal Server Error', error.message, path), { status: 500 });
            })
        );

    } else {
        // 如果代理未配置，且请求不是虚拟文件请求
        console.warn(`SW: No proxyUrl configured. Cannot handle request for: ${url.href}. Responding with error.`);
        event.respondWith(
            new Response(buildErrorPage('503 - Service Unavailable', 'Proxy endpoint not configured', null), { status: 503, statusText: 'Service Unavailable' })
        );
    }
});


// --- 辅助函数 ---

// 心跳
const HeartBeatInterval = 5000;
const HeartBeatTimeout = 10000;
let lastHeartBeatTime = null;
function initHeartBeat() {
    setInterval(() => {
        if (!idePort) return;
        postMessageToIde({ type: "HEART_BEAT" });

        // 超时
        if (Date.now() - lastHeartBeatTime > HeartBeatTimeout) {
            isHeartBeatTimeout = true;
            console.warn('SW: Heart Beat Timeout');
        }
    }, HeartBeatInterval);
}

// 设置
// Helper function to open the DB (returns a Promise)
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("v-domain", 1);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('settings')) {
                // Use 'key' as the key path (assuming your config has a 'key' property)
                // Or omit keyPath if you provide the key separately during add/put
                db.createObjectStore('settings', { keyPath: 'id' });
                console.log('SW: Object store created:', 'settings');
            }
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error('SW: IndexedDB error:', event.target.errorCode);
            reject(event.target.error);
        };
    });
}

// Function to save configuration
async function saveConfig(configObject = swSettings) {
    try {
        const db = await openDB();
        const transaction = db.transaction(['settings'], 'readwrite');
        const store = transaction.objectStore('settings', { autoIncrement: true });

        // Assuming configObject has an 'id' property like { id: 'userPrefs', theme: 'dark', ... }
        // If no keyPath was defined, use store.put(configObject, 'configKey');
        const request = store.put({ id: 0, value: configObject });

        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                console.log('SW: Configuration saved successfully:', configObject);
                resolve(true);
            };
            request.onerror = (event) => {
                console.error('SW: Error saving config:', event.target.error);
                reject(event.target.error);
            };
            transaction.oncomplete = () => {
                db.close(); // Close connection when transaction is done
            };
            transaction.onerror = (event) => {
                console.error('SW: Transaction error saving config:', event.target.error);
                reject(event.target.error); // Also reject on transaction error
            };
        });
    } catch (error) {
        console.error('SW: Failed to open DB for saving:', error);
        return false;
    }
}

// Function to load configuration
async function loadConfig(configId) {
    try {
        const db = await openDB();
        const transaction = db.transaction(['settings'], 'readonly');
        const store = transaction.objectStore('settings');
        const request = store.get(configId); // Use the ID/key to retrieve

        return new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
                const config = event.target.result;
                console.log('SW: Configuration loaded:', config);
                if (config) swSettings = { ...swSettings, ...config };
                resolve(config);
            };
            request.onerror = (event) => {
                console.error('SW: Error loading config:', event.target.error);
                reject(event.target.error);
            };
            transaction.oncomplete = () => {
                db.close();
            };
            transaction.onerror = (event) => {
                console.error('SW: Transaction error loading config:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('SW: Failed to open DB for loading:', error);
        return undefined;
    }
}

// 构造错误页面
function buildErrorPage(errorTitle, errorMessage, path, canAutoReload = false) {

    // 安全构造
    let targetPath;
    if (path) {
        const url = new URL("http://_/__loader.html");
        url.searchParams.append("redirect", path);
        targetPath = url.href.replace('http://_', '');
    }


    return new Blob([`
    <html>
        <head>
            <meta charset="utf-8">
            <title>VDomain Error</title>
        </head>
        <body>
            <h1>${errorTitle}</h1>
            <p>${errorMessage}</p>
            ${path ? `
                <hr>
                <button type="button" onclick="location.href='${targetPath}'">重新连接并重新加载</button>
                ${canAutoReload && swSettings.autoReloadOnDisconnect ? `
                    <p>自动重连中...</p>
                    <script>
                        // 延迟一小会再重连
                        setTimeout(() => {
                            location.href='${targetPath}'
                        }, 250);
                    </script>
                    ` : ''
            }
                ` : ''
        }
        </body>
    </html>
    `])
}

// 发送消息给 IDE (通过 MessagePort)
function postMessageToIde(message) {
    if (idePort) {
        try {
            // 可以添加一个开关来控制日志详细程度
            // console.log('SW: Sending message to IDE via Port:', message.type, message.payload);
            idePort.postMessage(message);
        } catch (error) {
            console.error('SW: Error posting message via IDE port:', error);
            // 这里可以尝试更复杂的错误处理，比如通知 IDE 通信中断
            // idePort = null; // 假设端口已失效
        }
    } else {
        console.error('SW: Cannot send message - IDE port not established.', message);
        throw new Error('Cannot send message - Port not established');
        // 可能需要一个消息队列来缓存消息，直到端口建立
    }
}

// 处理文件更新指令 (使用 Cache API)
async function handleUpdateFiles(filesPayload) {
    if (!filesPayload || typeof filesPayload !== 'object') {
        console.warn('SW: Invalid payload for UPDATE_FILES:', filesPayload);
        return;
    }
    try {
        const cache = await caches.open(swSettings.virtualCacheName);
        const operations = []; // 存储所有缓存操作的 Promise
        console.log('SW: Updating files in cache (received from VDomain)...');

        for (const path in filesPayload) {
            const fileData = filesPayload[path];
            const operationPath = path.startsWith('/') ? path : '/' + path; // 确保路径以 / 开头

            if (fileData === null) {
                // 删除文件
                operations.push(cache.delete(operationPath).then(deleted => {
                    if (deleted) console.log(`SW: Deleted from cache: ${operationPath}`);
                    else console.log(`SW: Attempted delete, but not found in cache: ${operationPath}`);
                }));
            } else if (fileData && typeof fileData === 'object' && fileData.content !== undefined) {
                // 添加或更新文件
                const mimeType = fileData.mimeType || 'application/octet-stream';
                const lastModified = (fileData.lastModified || Date.now()).toString(); // 转字符串存 header
                const content = fileData.content; // 可能是 Blob, ArrayBuffer, 或 string

                // 直接用 content 创建 Response 对象
                const responseToCache = new Response(content, {
                    headers: {
                        'Content-Type': mimeType,
                        'X-Last-Modified': lastModified,
                        // Content-Length 会由 Response 根据 content 类型自动计算
                    }
                });
                operations.push(cache.put(operationPath, responseToCache).then(() => {
                    console.log(`SW: Updated/Added to cache: ${operationPath} (Type: ${content?.constructor?.name})`);
                }));
            } else {
                console.warn(`SW: Invalid file data for path ${operationPath} in UPDATE_FILES:`, fileData);
            }
        }
        // 等待所有缓存操作完成
        await Promise.all(operations);
        console.log('SW: Cache update operations completed.');
    } catch (error) {
        console.error('SW: Error updating virtual file cache:', error);
        postMessageToIde({ type: 'ERROR', payload: `Cache update failed: ${error.message}` });
    }
}

// 处理 IDE 对文件状态查询的响应
async function handleFileStatusResponse({ requestId, action, fileData }) {
    const pending = PENDING_FILE_REQUESTS.get(requestId);
    if (!pending) {
        console.warn(`SW: Received file status response for unknown or timed out request ID: ${requestId}`);
        return;
    }

    clearTimeout(pending.timer); // 清除超时定时器
    console.log(`SW: Handling file status response for ${requestId}: Action=${action}`);

    try {
        let response;
        // 路径应该由 IDE 在 fileData 中提供，且是 SW 最初请求的路径
        const path = fileData?.path;
        if (!path) {
            throw new Error("Missing path in FILE_STATUS_RESPONSE fileData.");
        }

        switch (action) {
            case 'USE_CACHED':
                // 从 Cache API 获取缓存的响应
                const cachedResponse = await caches.match(path, { cacheName: swSettings.virtualCacheName });
                if (cachedResponse) {
                    console.log(`SW: Serving cached file from Cache API: ${path}`);
                    // 添加自定义头，表明是缓存命中
                    const headers = new Headers(cachedResponse.headers);
                    headers.set('X-Virtual-Cache-Status', 'HIT');
                    // 使用克隆的 body 创建新响应（以防原始响应流被消耗）
                    response = new Response(cachedResponse.body, {
                        status: cachedResponse.status,
                        statusText: cachedResponse.statusText,
                        headers: headers
                    });
                } else {
                    console.error(`SW: IDE said USE_CACHED but file not found in Cache API: ${path}`);
                    // 这种情况不应该发生，如果 IDE 逻辑正确的话
                    response = new Response(buildErrorPage('500 - Interal Server Error', 'Internal Cache Discrepancy', path), { status: 500 });
                }
                break;

            case 'UPDATE_AND_SERVE':
                // IDE 提供了新内容
                if (fileData.content !== undefined) {
                    const mimeType = fileData.mimeType || 'application/octet-stream';
                    const lastModified = (fileData.lastModified || Date.now()).toString();
                    const content = fileData.content; // string, ArrayBuffer, or Blob (from VDomain trigger)

                    const headers = {
                        'Content-Type': mimeType,
                        'X-Last-Modified': lastModified,
                        'X-Virtual-Cache-Status': 'UPDATED', // 表明是新内容
                        // Content-Length 会自动计算
                    }

                    // 是否启用CORS重写
                    if (swSettings.addCors) {
                        headers['Access-Control-Allow-Origin'] = '*';
                        headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
                        headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
                    }

                    // 使用新内容创建响应
                    response = new Response(content, {
                        headers
                    });
                    console.log(`SW: Serving updated file and caching: ${path}`);
                    // 异步更新缓存（不阻塞响应），需要克隆响应
                    const cache = await caches.open(swSettings.virtualCacheName);
                    cache.put(path, response.clone()).catch(cachePutError => {
                        console.error(`SW: Async cache put failed after UPDATE_AND_SERVE for ${path}:`, cachePutError);
                        postMessageToIde({ type: 'ERROR', payload: `Failed to cache updated file ${path}: ${cachePutError.message}` });
                    });
                } else {
                    console.error(`SW: IDE said UPDATE_AND_SERVE but content is missing for ${requestId}`);
                    response = new Response(buildErrorPage('500 - Interal Server Error', 'Invalid Update Data', path), { status: 500 });
                }
                break;

            case 'FILE_NOT_FOUND':
            default:
                // IDE 确认文件不存在
                console.log(`SW: File not found according to IDE: ${path}`);
                response = new Response(buildErrorPage('404 - Not Found', `Unable to found: ${path}`, path), { status: 404, statusText: 'Not Found' });
                break;
        }
        pending.resolve(response); // 用最终的 Response 对象 resolve fetch promise

    } catch (error) {
        console.error(`SW: Error processing file status response for ${requestId} (Path: ${fileData?.path}):`, error);
        // 如果处理响应时出错，拒绝 fetch promise
        pending.reject(new Error(`Internal error processing file status response: ${error.message}`));
    } finally {
        PENDING_FILE_REQUESTS.delete(requestId); // 无论成功失败，都清理 map
    }
}

// 处理 IDE 对代理权限请求的响应
function handleProxyResponse({ requestId, allowed }) {
    const pending = PENDING_PROXY_REQUESTS.get(requestId);
    if (!pending) {
        console.warn(`SW: Received proxy response for unknown or timed out request ID: ${requestId}`);
        return;
    }

    clearTimeout(pending.timer); // 清除超时
    console.log(`SW: Handling proxy response for ${requestId}: Allowed=${allowed}`);
    // 将 boolean 结果 (allowed) 传递给 fetch 事件中等待的 Promise 的 resolve 函数
    pending.resolve(allowed);
    PENDING_PROXY_REQUESTS.delete(requestId); // 清理 map
}

// 提取请求详情 (用于代理请求)
async function getRequestDetails(request) {
    const details = {
        url: request.url,
        method: request.method,
        headers: {},
        body: null, // Will hold body content (string or base64)
        bodyEncoding: null, // 'text', 'base64', or null
        originalContentType: null, // Only set for base64
        // Include other relevant options that the proxy might need
        mode: request.mode,
        credentials: request.credentials,
        cache: request.cache,
        redirect: request.redirect,
        referrer: request.referrer,
        integrity: request.integrity
    };

    // Copy headers
    request.headers.forEach((value, key) => {
        // Avoid forwarding certain browser-controlled headers if needed
        // if (key.toLowerCase() !== 'host' && !key.toLowerCase().startsWith('sec-')) {
        details.headers[key] = value;
        // }
    });

    // Process request body if applicable
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        try {
            // Clone the request to read the body without consuming the original
            const clonedRequest = request.clone();
            const contentType = request.headers.get('content-type') || '';

            // Heuristic: Try reading as text for common text types
            if (contentType.includes('application/json') || contentType.includes('text/') || contentType.includes('application/x-www-form-urlencoded')) {
                details.body = await clonedRequest.text();
                details.bodyEncoding = 'text';
            } else {
                // For other types (binary, FormData, etc.), read as Blob and convert to Base64
                // Note: This can be memory intensive for large files.
                const blob = await clonedRequest.blob();
                if (blob.size > 0) {
                    details.body = await convertBlobToBase64(blob);
                    details.bodyEncoding = 'base64';
                    details.originalContentType = contentType; // Send original type info
                } else {
                    details.body = null;
                    details.bodyEncoding = null;
                }
            }
        } catch (e) {
            console.warn(`SW: Could not read request body for proxy details (URL: ${request.url}):`, e);
            // Send error state to IDE/Proxy?
            details.body = null;
            details.bodyEncoding = 'error';
        }
    }

    return details;
}

// Blob 转 Base64 助手函数
async function convertBlobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => {
            // reader.result contains the Data URL ("data:mime/type;base64,...")
            // Extract only the Base64 part
            const dataUrl = reader.result;
            const base64String = dataUrl.substr(dataUrl.indexOf(',') + 1);
            resolve(base64String);
        };
        reader.readAsDataURL(blob);
    });
}

// Service Worker 内部的代理 fetch 函数 (在获得权限后调用)
async function proxyFetchInSW(originalRequest) {
    // 再次检查代理 URL，以防在等待权限期间被更改
    if (!swSettings.proxyUrl) {
        console.error("SW: Proxy URL became unavailable before executing proxy fetch.");
        return new Response(buildErrorPage("503 - Service Unavailable", "Proxy endpoint configuration changed.", null), { status: 503 });
    }

    console.log(`SW: Executing proxy fetch for: ${originalRequest.url}`);
    let proxyResponse; // Declare here to ensure it's in scope for return

    try {
        // 获取请求详情，这次是为了发送给 *我们自己的代理服务器*
        const proxyPayload = await getRequestDetails(originalRequest);

        // 构建发送给代理服务器的请求
        const proxyRequestOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // 可选：添加发送给代理服务器本身的认证头
                // 'X-Proxy-Auth': 'YOUR_SECRET_TOKEN'
            },
            body: JSON.stringify({ // 将原始请求细节打包为 JSON
                targetUrl: proxyPayload.url,
                originalOptions: {
                    method: proxyPayload.method,
                    headers: proxyPayload.headers,
                    body: proxyPayload.body, // null, string, or base64 string
                    bodyEncoding: proxyPayload.bodyEncoding,
                    originalContentType: proxyPayload.originalContentType,
                    // 传递其他相关选项给代理服务器处理
                    redirect: proxyPayload.redirect,
                    // cache: proxyPayload.cache, // Proxy likely controls its own caching
                    // mode: proxyPayload.mode, // Proxy makes the actual request, mode applies there
                    credentials: proxyPayload.credentials, // Important if target needs cookies
                }
            }),
            // 传递原始请求的 signal，允许 IDE 取消代理请求
            signal: originalRequest.signal,
            // 请求我们自己的代理服务器通常使用 'cors' 模式
            mode: 'cors',
            // 如果代理需要身份验证，可能需要 'include' credentials
            // credentials: 'include',
        };

        // 发送请求到我们自己的代理服务器
        proxyResponse = await fetch(swSettings.proxyUrl, proxyRequestOptions);

        console.log(`SW: Received response from proxy server for ${originalRequest.url}, status: ${proxyResponse.status}`);

        // 假设代理服务器成功时，会直接返回目标服务器的响应
        // （包括状态码、头信息、响应体）。
        // 如果代理服务器包装了响应（例如，在 JSON 对象里），你需要在这里解包。
        // 最简单的代理实现是直接透传。

        // 检查代理本身是否返回了错误状态（例如，代理配置错误、认证失败）
        if (!proxyResponse.ok && proxyResponse.status >= 500) {
            // Log or handle specific proxy server errors
            console.error(`SW: Proxy server itself returned error status ${proxyResponse.status} for ${originalRequest.url}`);
            // Optionally try to read error message from proxy response body
            // const errorBody = await proxyResponse.text();
            // postMessageToIde({ type: 'ERROR', payload: `Proxy Server Error: ${proxyResponse.status} - ${errorBody}`});
        }

        // 是否启用CORS重写
        if (swSettings.addCors) {
            const newHeaders = new Headers(proxyResponse.headers);
            newHeaders.set('Access-Control-Allow-Origin', '*');
            newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            return new Response(proxyResponse.body, {
                status: proxyResponse.status,
                statusText: proxyResponse.statusText,
                headers: newHeaders,
            });
        } else {
            return proxyResponse;
        }



    } catch (error) {
        console.error(`SW: Proxy fetch execution failed for ${originalRequest.url}:`, error);
        // 处理 fetch 本身的错误（网络问题、代理服务器不可达、请求被取消）
        if (error.name === 'AbortError') {
            // 如果是原始请求被取消导致的，返回一个表示取消的响应
            // 注意：直接 new Response(null, { status: 0 }) 可能不标准
            // 返回一个特定状态码或文本可能更好，但浏览器可能显示通用错误
            return new Response(buildErrorPage('499 - Client Closed Request', 'Request aborted by client.', originalRequest.url), { status: 499, statusText: 'Client Closed Request' }); // 499 is a non-standard code sometimes used
        }
        // 其他网络错误（代理服务器宕机、DNS 问题等）
        // 返回 502 Bad Gateway 通常比较合适
        return new Response(buildErrorPage('502 - Bad Gateway', `Proxy Execution Failed: Unable to connect to proxy server (${error.message})`, originalRequest.url), { status: 502, statusText: 'Bad Gateway' });
    }
}