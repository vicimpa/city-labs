// Parse before committing the save destination; a failed Open must preserve the previous document.
export async function validateHostFile(result, accept, { staged = false } = {}) {
  if (!result) return null;
  const bytes = Uint8Array.from(atob(result.bytesBase64), (c) => c.charCodeAt(0));
  const { decodeWorld } = await import('../format/world.js');
  await decodeWorld(bytes);
  let committed = false;
  const commit = async () => { if (!committed) { await accept(result.path); committed = true; } };
  if (!staged) await commit();
  return { path: result.path, bytes, ...(staged ? { commit } : {}) };
}
// Browser-first: native bindings are loaded only inside an actual Tauri webview.
if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  const callbacks = new Map(), queued = new Map();
  const action = (name, args = null) => invoke('host_action', { action: name, args });
  const report = (promise) => { promise.catch((e) => { console.error('Desktop:', e); alert(String(e)); }); };
  const bytesBase64 = (data) => {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  };
  const fileResult = async (promise) => {
    try {
      return await validateHostFile(await promise, (path) => action('acceptFile', { path }), { staged: true });
    } catch (e) { console.error('Open world:', e); alert(String(e.message ?? e)); return null; }
  };
  const events = ['file:changed', 'file:open-request', 'menu', 'app:save-and-close', 'mcp:call', 'update'];
  for (const event of events) await listen(event, ({ payload }) => {
    const listeners = callbacks.get(event);
    if (listeners?.length) for (const fn of listeners) fn(payload);
    else { const values = queued.get(event) ?? []; values.push(payload); queued.set(event, values); }
  });
  await listen('mcp:error', ({ payload }) => { console.error(payload); alert(payload); });
  const info = await action('info');
  if (info.mcpError) alert(info.mcpError);
  const pendingCalls = new Map();
  window.vspbHost = {
    platform: info.platform === 'macos' ? 'darwin' : info.platform === 'windows' ? 'win32' : 'linux',
    frameless: false,
    menu: () => report(action('menu')),
    zoom: () => report(action('zoom')),
    setLang: (lang) => report(action('setLang', { lang })),
    current: () => fileResult(action('current')),
    reload: () => fileResult(action('reload')),
    open: () => fileResult(action('open')),
    openPath: (path) => fileResult(action('openPath', { path })),
    openSample: () => fileResult(action('openSample')),
    newFile: () => action('newFile'),
    save: (bytes) => action('save', { bytesBase64: bytesBase64(bytes) }),
    saveAs: (bytes) => action('saveAs', { bytesBase64: bytesBase64(bytes) }),
    exportFile: (name, bytes) => action('exportFile', { name, bytesBase64: bytesBase64(bytes) }),
    info: () => action('info'),
    update: () => action('update'),
    setDirty: (dirty) => report(action('setDirty', { dirty })),
    setTitle: (title) => report(action('setTitle', { title })),
    closeNow: () => report(action('closeNow')),
    async toolResult(id, result) {
      const call = pendingCalls.get(id); pendingCalls.delete(id);
      if (call?.name === 'screenshot') {
        try {
          if (!result.isError) {
            const url = await window.editor.capture(call.args?.width);
            result = { ...result, content: [{ type: 'image', mimeType: 'image/png', data: url.split(',')[1] }, ...(result.content ?? [])] };
          }
        } catch (e) { result = { isError: true, content: [{ type: 'text', text: `Screenshot failed: ${e.message}` }] }; }
        finally { document.body.classList.remove('shot'); }
      }
      return action('toolResult', { id, result });
    },
    on(event, fn) {
      if (!events.includes(event)) return;
      const wrapped = event === 'mcp:call' ? (call) => { pendingCalls.set(call.id, call); Promise.resolve().then(() => fn(call)).catch((e) => window.vspbHost.toolResult(call.id, { isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] })); } : fn;
      const listeners = callbacks.get(event) ?? []; listeners.push(wrapped); callbacks.set(event, listeners);
      for (const payload of queued.get(event) ?? []) queueMicrotask(() => wrapped(payload));
      queued.delete(event);
    },
  };
  // Event listeners already exist, so OS-open requests arriving before editor boot are queued safely.
  await action('ready');
}
