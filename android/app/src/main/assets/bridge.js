/*
 * CloudCLI Android bridge (contract §3.4-§3.6).
 * Injected at document start for the configured origin only.
 * `__CLOUDCLI_ORIGIN__` is replaced by the native side with a JSON string literal.
 */
(function () {
  'use strict';

  var ORIGIN = __CLOUDCLI_ORIGIN__;
  var CHUNK_SIZE = 262144;
  var NATIVE_NAME = 'cloudcliAndroidNative';

  if (window.top !== window) {
    return;
  }
  if (window.location.origin !== ORIGIN) {
    return;
  }
  if (window.cloudcliAndroid && window.cloudcliAndroid.version === 1) {
    return;
  }
  var native = window[NATIVE_NAME];
  if (!native || typeof native.postMessage !== 'function') {
    return;
  }

  var seq = 0;
  var pending = Object.create(null);
  var ackWaiters = Object.create(null);
  var incoming = Object.create(null);

  function nextId() {
    seq += 1;
    return 'c-' + seq;
  }

  function post(message) {
    native.postMessage(JSON.stringify(message));
  }

  function bridgeError(code, message) {
    var error = new Error(message || code);
    error.name = 'AndroidBridgeError';
    error.code = code;
    return error;
  }

  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId();
      pending[id] = { resolve: resolve, reject: reject };
      post({ v: 1, id: id, method: method, params: params || {} });
    });
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('cloudcliandroid:' + name, { detail: detail }));
    } catch (error) {
      /* ignore */
    }
  }

  function frame(transferId, offset, bytes) {
    var header = new TextEncoder().encode(JSON.stringify({
      transferId: transferId,
      offset: offset,
      length: bytes.length
    }));
    var out = new Uint8Array(4 + header.length + bytes.length);
    new DataView(out.buffer).setUint32(0, header.length, false);
    out.set(header, 4);
    out.set(bytes, 4 + header.length);
    return out.buffer;
  }

  function sendChunk(transferId, offset, bytes) {
    return new Promise(function (resolve, reject) {
      ackWaiters[transferId] = { resolve: resolve, reject: reject };
      native.postMessage(frame(transferId, offset, bytes));
    });
  }

  function finishTransfer(transferId) {
    return request('transfer.finish', { transferId: transferId });
  }

  function sendBlob(transferId, blob) {
    var size = blob.size;

    function sendFrom(offset) {
      if (size === 0) {
        return sendChunk(transferId, 0, new Uint8Array(0)).then(function () {
          return finishTransfer(transferId);
        });
      }
      if (offset >= size) {
        return finishTransfer(transferId);
      }
      var end = Math.min(offset + CHUNK_SIZE, size);
      return blob.slice(offset, end).arrayBuffer().then(function (buffer) {
        return sendChunk(transferId, offset, new Uint8Array(buffer));
      }).then(function (ack) {
        return sendFrom(ack.nextOffset);
      });
    }

    return sendFrom(0);
  }

  function receiveTransfer(meta) {
    return new Promise(function (resolve, reject) {
      incoming[meta.transferId] = {
        meta: meta,
        parts: [],
        received: 0,
        resolve: resolve,
        reject: reject
      };
    });
  }

  function onChunk(buffer) {
    if (buffer.byteLength < 4) {
      return;
    }
    var view = new DataView(buffer);
    var headerLength = view.getUint32(0, false);
    if (4 + headerLength > buffer.byteLength) {
      return;
    }
    var header;
    try {
      header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength)));
    } catch (error) {
      return;
    }
    var payload = new Uint8Array(buffer, 4 + headerLength);
    var entry = incoming[header.transferId];
    if (!entry) {
      return;
    }
    if (header.offset !== entry.received || payload.length !== header.length || payload.length > CHUNK_SIZE) {
      delete incoming[header.transferId];
      entry.reject(bridgeError('TRANSFER_FAILED', 'Unexpected chunk'));
      return;
    }
    entry.parts.push(payload.slice());
    entry.received += payload.length;
    post({ v: 1, type: 'transfer.ack', transferId: header.transferId, nextOffset: entry.received });
    if (entry.received >= entry.meta.size) {
      delete incoming[header.transferId];
      var blob = new Blob(entry.parts, { type: entry.meta.mimeType || 'application/octet-stream' });
      var result = {
        name: entry.meta.name,
        mimeType: entry.meta.mimeType || blob.type,
        size: entry.meta.size,
        blob: blob
      };
      finishTransfer(header.transferId).then(function () {
        entry.resolve(result);
      }, function () {
        entry.reject(bridgeError('TRANSFER_FAILED', 'Transfer finish failed'));
      });
    }
  }

  function onJson(data) {
    var message;
    try {
      message = JSON.parse(data);
    } catch (error) {
      return;
    }
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'transfer.ack') {
      var waiter = ackWaiters[message.transferId];
      if (waiter) {
        delete ackWaiters[message.transferId];
        waiter.resolve({ nextOffset: message.nextOffset });
      }
      return;
    }
    if (message.type === 'transfer.abort') {
      var aborted = ackWaiters[message.transferId];
      if (aborted) {
        delete ackWaiters[message.transferId];
        aborted.reject(bridgeError('TRANSFER_FAILED', message.reason || 'Transfer aborted'));
      }
      var pendingRead = incoming[message.transferId];
      if (pendingRead) {
        delete incoming[message.transferId];
        pendingRead.reject(bridgeError('TRANSFER_FAILED', message.reason || 'Transfer aborted'));
      }
      return;
    }
    if (message.event) {
      emit(message.event, message.data);
      return;
    }
    if (message.id) {
      var entry = pending[message.id];
      if (!entry) {
        return;
      }
      delete pending[message.id];
      if (message.ok) {
        entry.resolve(message.result);
      } else {
        var code = message.error && message.error.code ? message.error.code : 'UNAVAILABLE';
        entry.reject(bridgeError(code, message.error && message.error.message));
      }
    }
  }

  native.onmessage = function (event) {
    var data = event.data;
    if (typeof data === 'string') {
      onJson(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      onChunk(data);
    }
  };

  function pickFiles(options) {
    options = options || {};
    var params = { multiple: !!options.multiple };
    if (typeof options.maxBytes === 'number') {
      params.maxBytes = options.maxBytes;
    }
    if (typeof options.maxFiles === 'number') {
      params.maxFiles = options.maxFiles;
    }
    return request('file.pick', params).then(function (result) {
      var files = (result && result.files) || [];
      return Promise.all(files.map(receiveTransfer));
    });
  }

  function saveFile(input) {
    if (!input || !input.blob) {
      return Promise.reject(bridgeError('INVALID_ARGUMENT', 'blob is required'));
    }
    var mimeType = input.mimeType || input.blob.type || 'application/octet-stream';
    return request('file.save', {
      name: input.name || 'download',
      mimeType: mimeType,
      size: input.blob.size
    }).then(function (result) {
      return sendBlob(result.transferId, input.blob);
    }).then(function (result) {
      return { saved: !(result && result.saved === false) };
    });
  }

  function getShareContent(id) {
    return request('share.content', { id: id }).then(receiveTransfer);
  }

  window.cloudcliAndroid = {
    version: 1,
    getState: function () {
      return request('getState', {});
    },
    notify: function (input) {
      return request('notify', input || {});
    },
    setNotificationsEnabled: function (enabled) {
      return request('setNotificationsEnabled', { enabled: !!enabled });
    },
    getSession: function () {
      return request('getSession', {});
    },
    saveSession: function (token) {
      return request('saveSession', { token: token });
    },
    clearSession: function () {
      return request('clearSession', {});
    },
    listShares: function () {
      return request('listShares', {});
    },
    getShareContent: getShareContent,
    consumeShare: function (id) {
      return request('consumeShare', { id: id });
    },
    discardShare: function (id) {
      return request('discardShare', { id: id });
    },
    pickFiles: pickFiles,
    saveFile: saveFile
  };
})();
