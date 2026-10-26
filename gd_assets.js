/* Lossless, cacheable assets on static hosts.
 * Split WASM gzip files are concatenated before decompression.
 * Chunks are cached, stall-watched, and retried with integrity checks. */
(function () {
  'use strict';
  var manifestPromise;
  var pending = Object.create(null);
  var maxJobs = 2;
  try {
    var q = new URLSearchParams(location.search).get('jobs');
    if (q) { var n = parseInt(q, 10); if (n >= 1 && n <= 8) maxJobs = n; }
  } catch (e) { }
  var activeJobs = 0, jobWaiters = [];
  function acquire() {
    if (activeJobs < maxJobs) { activeJobs++; return Promise.resolve(); }
    return new Promise(function (resolve) { jobWaiters.push(resolve); });
  }
  function release() {
    activeJobs--;
    var next = jobWaiters.shift();
    if (next) { activeJobs++; next(); }
  }

  var assetCachePromise;
  function assetCache() {
    if (!assetCachePromise) {
      assetCachePromise = ('caches' in window ? caches.open('gdwasm-assets') : Promise.reject(0))
        .catch(function () { return null; });
    }
    return assetCachePromise;
  }

  var stallMs = 30000;
  function readChunk(reader, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('Asset transfer stalled for ' + Math.round(timeoutMs / 1000) + 's'));
      }, timeoutMs);
      reader.read().then(function (r) { clearTimeout(timer); resolve(r); },
        function (e) { clearTimeout(timer); reject(e); });
    });
  }

  async function readAllBytes(body, timeoutMs, expectedSize) {
    var reader = body.getReader();
    var out = expectedSize ? new Uint8Array(expectedSize) : null;
    var parts = out ? null : [], total = 0;
    for (; ;) {
      var next;
      try { next = await readChunk(reader, timeoutMs); }
      catch (e) { try { await reader.cancel(e); } catch (_) { } throw e; }
      if (next.done) break;
      if (out) {
        if (total + next.value.length > out.length) {
          try { await reader.cancel(); } catch (_) { }
          throw new Error('Asset is larger than expected');
        }
        out.set(next.value, total);
      } else parts.push(next.value);
      total += next.value.length;
    }
    if (out) {
      if (total !== out.length) throw new Error('Asset download was interrupted');
      return out;
    }
    var joined = new Uint8Array(total);
    for (var i = 0, off = 0; i < parts.length; i++) {
      joined.set(parts[i], off);
      off += parts[i].length;
    }
    return joined;
  }

  function watchdogStream(body, timeoutMs, onProgress) {
    var reader = body.getReader();
    return new ReadableStream({
      async pull(ctrl) {
        var next;
        try { next = await readChunk(reader, timeoutMs); }
        catch (e) {
          try { await reader.cancel(e); } catch (_) { }
          ctrl.error(e);
          return;
        }
        if (next.done) { ctrl.close(); return; }
        if (onProgress) onProgress(next.value.length);
        ctrl.enqueue(next.value);
      },
      cancel: function (reason) {
        try { return reader.cancel(reason); } catch (_) { }
      }
    });
  }

  function version() {
    return typeof GD_BUILD_ID === 'string' ? GD_BUILD_ID : 'dev';
  }

  function manifest() {
    if (!manifestPromise) {
      manifestPromise = fetch('gd_assets.json?v=' + version(), { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('Asset manifest HTTP ' + r.status);
          return r.json();
        });
    }
    return manifestPromise;
  }

  function report(kind, loaded, total) {
    if (typeof setAssetBar === 'function') setAssetBar(kind, loaded, total);
    if (window.Module) {
      Module.dataFileDownloads = Module.dataFileDownloads || {};
      Module.dataFileDownloads['gd_web.' + (kind === 'data' ? 'data' : 'wasm')] =
        { loaded: loaded, total: total };
    }
  }

  async function fetchCompressedBytes(entry, signal, attempt) {
    var cache = await assetCache();
    var r = null;

    if (cache && !attempt) {
      try { r = await cache.match(entry.url); } catch (e) { }
    }

    if (!r) {
      r = await fetch(entry.url, {
        cache: attempt ? 'reload' : 'force-cache',
        signal: signal
      });

      if (!r.ok) throw new Error(entry.url + ': HTTP ' + r.status);
      if (!r.body) throw new Error('This browser cannot stream game assets.');

      if (cache) {
        var put = cache.put(entry.url, r.clone());
        if (put && put.catch) put.catch(function () { });
      }
    }

    return await readAllBytes(r.body, stallMs);
  }

  async function compressedResponse(entry, signal, attempt) {
    var bytes = await fetchCompressedBytes(entry, signal, attempt);
    var source = new Response(bytes).body;
    var body = source.pipeThrough(new DecompressionStream('gzip'));
    return new Response(body, { headers: { 'Content-Type': 'application/wasm' } });
  }

  async function wasmResponse(m, signal, attempt) {
    if (typeof DecompressionStream === 'undefined') {
      var fallback = await fetch('gd_web.wasm?v=' + version(), {
        cache: attempt ? 'reload' : 'force-cache',
        signal: signal
      });
      if (!fallback.ok) throw new Error('Game WASM HTTP ' + fallback.status);
      return fallback;
    }

    // New manifest format: wasm.parts is an ordered list of gzip file pieces.
    // Concatenate the compressed bytes first, then decompress the complete gzip.
    if (m.wasm.parts && m.wasm.parts.length) {
      var all = [];
      var total = 0;
      for (var i = 0; i < m.wasm.parts.length; i++) {
        var part = m.wasm.parts[i];
        var bytes = await fetchCompressedBytes(part, signal, attempt);
        all.push(bytes);
        total += bytes.length;
        report('wasm', total, m.wasm.compressedSize || total);
      }
      var joined = new Uint8Array(total);
      var offset = 0;
      for (var j = 0; j < all.length; j++) {
        joined.set(all[j], offset);
        offset += all[j].length;
      }
      var body = new Response(joined).body.pipeThrough(new DecompressionStream('gzip'));
      return new Response(body, { headers: { 'Content-Type': 'application/wasm' } });
    }

    // Backwards compatibility with the original single-file manifest.
    return compressedResponse(m.wasm, signal, attempt);
  }

  async function retry(operation, signal, retryable) {
    for (var attempt = 0; ; attempt++) {
      try { return await operation(attempt); }
      catch (e) {
        if (signal && signal.aborted) throw e;
        if (attempt >= 4) throw e;
        if (retryable && !retryable(e)) throw e;
        await new Promise(function (resolve) {
          setTimeout(resolve, 400 * (attempt + 1));
        });
      }
    }
  }

  function isNetworkError(e) {
    var msg = String(e && e.message || e);
    return /Network error|Failed to read|ERR_|fetch|aborted|stream|stalled|interrupted|HTTP 5\d\d/i.test(msg);
  }

  async function data(url, expectedSize) {
    if (typeof DecompressionStream === 'undefined') return rawData(url, expectedSize);
    var m = await manifest();
    if (m.data.size !== expectedSize) {
      throw new Error('Game files belong to different builds. Reload to update.');
    }
    var out = new Uint8Array(expectedSize);
    var controller = new AbortController();
    var index = 0, loaded = 0;

    async function worker() {
      while (index < m.data.chunks.length) {
        var chunk = m.data.chunks[index++];
        var bytes = await retry(async function (attempt) {
          await acquire();
          try {
            var response = await compressedResponse(chunk, controller.signal, attempt);
            var bytes = await readAllBytes(response.body, stallMs, chunk.size);
            if (window.crypto && crypto.subtle) {
              var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
              var hex = Array.from(digest, function (v) {
                return v.toString(16).padStart(2, '0');
              }).join('');
              if (hex !== chunk.sha256) throw new Error('Corrupt asset: ' + chunk.url);
            }
            return bytes;
          } finally { release(); }
        }, controller.signal);
        out.set(bytes, chunk.offset);
        loaded += bytes.length;
        report('data', loaded, expectedSize);
      }
    }

    try { await Promise.all([worker(), worker()]); }
    catch (e) { controller.abort(); throw e; }
    return out.buffer;
  }

  async function rawData(url, expectedSize) {
    await acquire();
    try {
      var r = await fetch(url, { cache: 'force-cache' });
      if (!r.ok) throw new Error('Game data HTTP ' + r.status);
      var out = new Uint8Array(expectedSize), offset = 0;
      var reader = r.body.getReader();
      for (; ;) {
        var next = await reader.read();
        if (next.done) break;
        if (offset + next.value.length > out.length) {
          throw new Error('Game data has the wrong size.');
        }
        out.set(next.value, offset);
        offset += next.value.length;
        report('data', offset, expectedSize);
      }
      if (offset !== expectedSize) throw new Error('Game data download was interrupted.');
      return out.buffer;
    } finally { release(); }
  }

  async function wasm(imports, success) {
    var m = await manifest();
    var result = await retry(async function (attempt) {
      await acquire();
      try {
        var r = await wasmResponse(m, undefined, attempt);
        var loaded = 0;
        var stream = watchdogStream(r.body, stallMs, function (n) {
          loaded += n;
          report('wasm', loaded, m.wasm.size);
        });
        var out = await WebAssembly.instantiateStreaming(new Response(stream, {
          headers: { 'Content-Type': 'application/wasm' }
        }), imports);
        return out;
      } finally {
        release();
      }
    }, undefined, isNetworkError);

    report('wasm', m.wasm.size, m.wasm.size);
    success(result.instance, result.module);
  }

  function fail(e) {
    console.error(e);
    var el = document.getElementById('errOverlay');
    if (el) {
      el.textContent = 'Could not load the game: ' + e.message +
        '. Reload to retry; completed chunks stay cached.';
      el.classList.add('on');
    }
  }

  window.GDAssets = {
    loadScript: async function () {
      var m = await manifest();
      if (m.game && m.game.gameVersion && m.game.steamBuild) {
        var badge = document.getElementById('version');
        if (badge) {
          badge.textContent = 'GD ' + m.game.gameVersion + ' · Steam ' +
            m.game.steamBuild + ' · Port ' + String(m.build || 'dev').slice(0, 8);
          badge.title = 'Port package ' + (m.build || 'dev');
        }
        document.title = 'Geometry Dash ' + m.game.gameVersion + ' · ' + m.game.steamBuild;
      }
      await acquire();
      try {
        var response = typeof DecompressionStream === 'undefined'
          ? await fetch('gd_web.js?v=' + version(), { cache: 'force-cache' })
          : await compressedResponse(m.loader);
        if (!response.ok) throw new Error('Game script HTTP ' + response.status);
        var bytes = await readAllBytes(response.body, stallMs);
        return new TextDecoder('utf-8').decode(bytes);
      } finally {
        release();
      }
    },

    loadData: function (url, size) {
      if (!pending[url]) {
        pending[url] = data(url, size).catch(function (e) {
          delete pending[url];
          fail(e);
          throw e;
        });
      }
      return pending[url].then(function (result) {
        delete pending[url];
        return result;
      });
    },

    instantiateWasm: function (imports, success) {
      wasm(imports, success).catch(fail);
      return {};
    },

    fail: fail
  };
})();