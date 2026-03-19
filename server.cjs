#!/usr/bin/env node
// Hydra live-coding relay server
// Serves static files + WebSocket code relay + save/load API
//
// Usage: node server.cjs [port]
// Default port: 8080

process.on('uncaughtException', function (err) {
  console.error('UNCAUGHT:', err)
})
process.on('unhandledRejection', function (err) {
  console.error('UNHANDLED REJECTION:', err)
})

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const WsServer = require('ws').Server

// Active ProRes recording sessions: sessionId → { ffmpeg, filePath, folder, frameCount }
var recSessions = {}

// Ableton Link (optional — native addon, install with: npm install abletonlink)
var AbletonLink = null
var link = null
try {
  AbletonLink = require('abletonlink')
  link = new AbletonLink()
  link.bpm = 120
  link.quantum = 4
  link.startUpdate(20, function () {})  // Required: poll Link timeline at 20ms
  console.log('  Ableton Link loaded.')
} catch (e) {
  console.log('  Ableton Link not available (install abletonlink for Link support)')
}

const PORT = parseInt(process.argv[2], 10) || 8080
const ROOT = __dirname
const PRESETS_DIR = path.join(ROOT, 'presets')
const RECORDINGS_DIR = path.join(ROOT, 'recordings')

// ---- Settings system ----
const SETTINGS_DEFAULTS_PATH = path.join(ROOT, 'settings.defaults.json')
const SETTINGS_PATH = path.join(ROOT, 'settings.json')

function expandHome (p) {
  if (typeof p === 'string' && p.startsWith('~/')) {
    return path.join(require('os').homedir(), p.slice(2))
  }
  return p
}

function loadSettings () {
  var defaults = {}
  try { defaults = JSON.parse(fs.readFileSync(SETTINGS_DEFAULTS_PATH, 'utf8')) } catch (e) {}
  var user = {}
  try { user = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) } catch (e) {}
  // Shallow merge — user overrides win
  return Object.assign({}, defaults, user)
}

function saveSettings (patch) {
  var current = {}
  try { current = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) } catch (e) {}
  var merged = Object.assign({}, current, patch)
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return loadSettings()
}

function getCaptureDir () {
  var settings = loadSettings()
  var dir = expandHome(settings.captureDir || '~/HydraVJ/frames')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) {}
  return dir
}

// Daydream API config
function getDaydreamConfig () {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'daydream.config.json'), 'utf8'))
  } catch (e) { return {} }
}
function getDaydreamKey () {
  return process.env.DAYDREAM_API_KEY || getDaydreamConfig().apiKey || null
}
function getScopeUrl () {
  return process.env.SCOPE_URL || getDaydreamConfig().scopeUrl || null
}

// Shared Daydream stream state (browser creates, TD can update)
var activeDaydreamStreamId = null
var activeDaydreamPlaybackId = null

// Health check state (browser posts via hydraHealth(), external tools GET /api/health)
var lastHydraHealth = null
var lastHydraHealthTs = null

// Scope process management
var scopeProcess = null
var SCOPE_DIR = path.join(ROOT, '..', 'scope')
var SCOPE_PORT = 8000

function isScopeRunning (cb) {
  var done = false
  var req = http.get('http://localhost:' + SCOPE_PORT + '/health', function (res) {
    var chunks = []
    res.on('data', function (c) { chunks.push(c) })
    res.on('end', function () {
      if (done) return
      done = true
      try {
        var data = JSON.parse(Buffer.concat(chunks).toString())
        cb(data.status === 'healthy')
      } catch (e) { cb(false) }
    })
  })
  req.on('error', function () { if (!done) { done = true; cb(false) } })
  req.setTimeout(3000, function () { req.destroy(); if (!done) { done = true; cb(false) } })
}

function startScope (cb) {
  isScopeRunning(function (running) {
    if (running) return cb(null, { status: 'already_running' })
    // Check scope dir exists
    if (!fs.existsSync(SCOPE_DIR)) return cb(new Error('Scope not found at ' + SCOPE_DIR))
    var spawn = require('child_process').spawn
    var uvPath = process.env.HOME + '/.local/bin/uv'
    scopeProcess = spawn(uvPath, ['run', 'daydream-scope', '--host', '0.0.0.0', '--port', String(SCOPE_PORT)], {
      cwd: SCOPE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1' })
    })
    scopeProcess.unref()
    console.log('  Scope: starting (pid ' + scopeProcess.pid + ')...')
    // Capture early output for debugging
    scopeProcess.stderr.on('data', function (d) {
      var line = d.toString().trim()
      if (line) console.log('  Scope: ' + line.split('\n')[0])
    })
    scopeProcess.on('exit', function (code) {
      console.log('  Scope: process exited (code ' + code + ')')
      scopeProcess = null
    })
    // Poll for healthy
    var attempts = 0
    var maxAttempts = 60 // 60 seconds
    var poll = setInterval(function () {
      attempts++
      isScopeRunning(function (healthy) {
        if (healthy) {
          clearInterval(poll)
          console.log('  Scope: healthy after ' + attempts + 's')
          cb(null, { status: 'started', pid: scopeProcess ? scopeProcess.pid : null })
        } else if (attempts >= maxAttempts) {
          clearInterval(poll)
          cb(new Error('Scope failed to start within ' + maxAttempts + 's'))
        }
      })
    }, 1000)
  })
}

function stopScope (cb) {
  if (scopeProcess) {
    console.log('  Scope: killing process (pid ' + scopeProcess.pid + ')...')
    try { process.kill(-scopeProcess.pid, 'SIGTERM') } catch (e) {
      try { scopeProcess.kill('SIGTERM') } catch (e2) {}
    }
    scopeProcess = null
  }
  // Also kill anything on the port (zombie processes)
  var exec = require('child_process').exec
  exec('lsof -ti :' + SCOPE_PORT + ' | xargs kill -9 2>/dev/null', function () {
    setTimeout(function () { cb(null) }, 1500)
  })
}

function restartScope (cb) {
  stopScope(function () {
    startScope(cb)
  })
}

function daydreamRequest (method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    var key = getDaydreamKey()
    if (!key) return reject(new Error('No Daydream API key'))
    var postData = body ? JSON.stringify(body) : ''
    var opts = {
      hostname: 'api.daydream.live',
      path: urlPath,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json'
      }
    }
    if (postData) opts.headers['Content-Length'] = Buffer.byteLength(postData)
    var req = https.request(opts, function (res) {
      var chunks = []
      res.on('data', function (c) { chunks.push(c) })
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString()
        try { resolve({ status: res.statusCode, data: JSON.parse(raw), headers: res.headers }) }
        catch (e) { resolve({ status: res.statusCode, data: raw, headers: res.headers }) }
      })
    })
    req.on('error', reject)
    if (postData) req.write(postData)
    req.end()
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
}

function jsonResponse (res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
  res.end(JSON.stringify(data))
}

function readBody (req, cb) {
  var chunks = []
  req.on('data', function (c) { chunks.push(c) })
  req.on('end', function () { cb(Buffer.concat(chunks).toString()) })
}

function slugify (name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 80)
}

// HTTP server
const server = http.createServer(function (req, res) {
  var urlPath = req.url.split('?')[0]

  // ---- API: health check (browser posts state, external tools query it) ----
  if (req.method === 'GET' && urlPath === '/api/health') {
    jsonResponse(res, 200, {
      status: 'ok',
      hydraState: lastHydraHealth,
      updatedAt: lastHydraHealthTs,
      serverUptime: Math.floor(process.uptime())
    })
    return
  }
  if (req.method === 'POST' && urlPath === '/api/health') {
    readBody(req, function (body) {
      try {
        lastHydraHealth = JSON.parse(body)
        lastHydraHealthTs = new Date().toISOString()
        jsonResponse(res, 200, { stored: true })
      } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON' })
      }
    })
    return
  }

  // ---- API: list presets ----
  if (req.method === 'GET' && urlPath === '/api/presets') {
    var indexPath = path.join(PRESETS_DIR, 'index.json')
    fs.readFile(indexPath, 'utf8', function (err, data) {
      if (err) return jsonResponse(res, 500, { error: 'Cannot read index.json' })
      try {
        var entries = JSON.parse(data)
        var presets = entries.map(function (e) {
          return { file: e.file, name: e.name || e.file.replace(/\.md$/, '').replace(/-/g, ' '), description: e.description || '' }
        })
        jsonResponse(res, 200, presets)
      } catch (e) {
        jsonResponse(res, 500, { error: 'Invalid index.json' })
      }
    })
    return
  }

  // ---- API: load a preset ----
  if (req.method === 'GET' && urlPath.startsWith('/api/presets/')) {
    var fileName = path.basename(urlPath)
    var filePath = path.join(PRESETS_DIR, fileName)
    if (!filePath.startsWith(PRESETS_DIR)) return jsonResponse(res, 403, { error: 'Forbidden' })
    fs.readFile(filePath, 'utf8', function (err, data) {
      if (err) return jsonResponse(res, 404, { error: 'Not found' })
      jsonResponse(res, 200, { file: fileName, content: data })
    })
    return
  }

  // ---- API: save a preset ----
  if (req.method === 'POST' && urlPath === '/api/presets') {
    readBody(req, function (body) {
      try {
        var data = JSON.parse(body)
        if (!data.name || !data.code) return jsonResponse(res, 400, { error: 'name and code required' })
        var slug = slugify(data.name)
        if (!slug) return jsonResponse(res, 400, { error: 'Invalid name' })
        var file = slug + '.md'
        var content = '# ' + data.name + '\n\n```js\n' + data.code.trim() + '\n```\n'
        if (data.filters) {
          content += '\n<!-- filters:' + JSON.stringify(data.filters) + ' -->\n'
        }
        fs.writeFile(path.join(PRESETS_DIR, file), content, 'utf8', function (err) {
          if (err) return jsonResponse(res, 500, { error: 'Write failed' })
          // Update index.json
          var indexPath = path.join(PRESETS_DIR, 'index.json')
          var index = []
          try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) } catch (e) {}
          if (!index.some(function (e) { return e.file === file })) {
            index.push({ id: slug, name: data.name, file: file, description: data.description || '' })
            fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n')
          }
          jsonResponse(res, 200, { saved: file })
        })
      } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON' })
      }
    })
    return
  }

  // ---- API: delete a preset ----
  if (req.method === 'DELETE' && urlPath.startsWith('/api/presets/')) {
    var delName = path.basename(urlPath)
    var delPath = path.join(PRESETS_DIR, delName)
    if (!delPath.startsWith(PRESETS_DIR)) return jsonResponse(res, 403, { error: 'Forbidden' })
    // Move to _archive instead of deleting
    var archiveDir = path.join(PRESETS_DIR, '_archive')
    try { fs.mkdirSync(archiveDir, { recursive: true }) } catch (e) {}
    fs.rename(delPath, path.join(archiveDir, delName), function (err) {
      if (err) return jsonResponse(res, 404, { error: 'Not found' })
      // Update index.json
      var indexPath = path.join(PRESETS_DIR, 'index.json')
      try {
        var index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
        index = index.filter(function (e) { return e.file !== delName })
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n')
      } catch (e) {}
      jsonResponse(res, 200, { archived: delName })
    })
    return
  }

  // ---- API: list map presets ----
  if (req.method === 'GET' && urlPath === '/api/maps') {
    var mapsDir = path.join(__dirname, 'presets', 'maps')
    if (!fs.existsSync(mapsDir)) {
      return jsonResponse(res, 200, [])
    }
    var files = fs.readdirSync(mapsDir).filter(function (f) { return f.endsWith('.json') })
    var maps = files.map(function (f) {
      try {
        var data = JSON.parse(fs.readFileSync(path.join(mapsDir, f), 'utf8'))
        return { file: f, name: data.name || f.replace('.json', '') }
      } catch (e) {
        return null
      }
    }).filter(Boolean)
    jsonResponse(res, 200, maps)
    return
  }

  // ---- API: load a map preset ----
  if (req.method === 'GET' && urlPath.startsWith('/api/maps/')) {
    var mapName = path.basename(urlPath)
    var mapFile = path.join(__dirname, 'presets', 'maps', mapName + '.json')
    if (!fs.existsSync(mapFile)) {
      return jsonResponse(res, 404, { error: 'Map preset not found' })
    }
    try {
      var mapData = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
      jsonResponse(res, 200, mapData)
    } catch (e) {
      jsonResponse(res, 500, { error: 'Failed to read map preset' })
    }
    return
  }

  // ---- API: save a map preset ----
  if (req.method === 'POST' && urlPath === '/api/maps') {
    readBody(req, function (body) {
      try {
        var data = JSON.parse(body)
        if (!data.name) return jsonResponse(res, 400, { error: 'name is required' })
        var mapsDir = path.join(__dirname, 'presets', 'maps')
        if (!fs.existsSync(mapsDir)) {
          fs.mkdirSync(mapsDir, { recursive: true })
        }
        var slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
        var file = path.join(mapsDir, slug + '.json')
        fs.writeFileSync(file, JSON.stringify(data, null, 2))
        jsonResponse(res, 200, { ok: true, file: slug + '.json' })
      } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON' })
      }
    })
    return
  }

  // ---- API: archive a map preset ----
  if (req.method === 'DELETE' && urlPath.startsWith('/api/maps/')) {
    var delMapName = path.basename(urlPath)
    var delMapFile = path.join(__dirname, 'presets', 'maps', delMapName + '.json')
    if (!fs.existsSync(delMapFile)) {
      return jsonResponse(res, 404, { error: 'Map preset not found' })
    }
    var mapArchiveDir = path.join(__dirname, 'presets', 'maps', '_archive')
    try { fs.mkdirSync(mapArchiveDir, { recursive: true }) } catch (e) {}
    fs.rename(delMapFile, path.join(mapArchiveDir, delMapName + '.json'), function (err) {
      if (err) return jsonResponse(res, 500, { error: 'Archive failed' })
      jsonResponse(res, 200, { archived: delMapName })
    })
    return
  }

  // ---- API: Scope start ----
  if (req.method === 'POST' && urlPath === '/api/scope/start') {
    startScope(function (err, result) {
      if (err) return jsonResponse(res, 500, { error: err.message })
      jsonResponse(res, 200, result)
    })
    return
  }

  // ---- API: Scope restart ----
  if (req.method === 'POST' && urlPath === '/api/scope/restart') {
    restartScope(function (err, result) {
      if (err) return jsonResponse(res, 500, { error: err.message })
      jsonResponse(res, 200, result)
    })
    return
  }

  // ---- API: Scope stop ----
  if (req.method === 'POST' && urlPath === '/api/scope/stop') {
    stopScope(function () {
      jsonResponse(res, 200, { status: 'stopped' })
    })
    return
  }

  // ---- API: Scope health ----
  if (req.method === 'GET' && urlPath === '/api/scope/health') {
    isScopeRunning(function (healthy) {
      jsonResponse(res, 200, { running: healthy })
    })
    return
  }

  // ---- API: List Scope presets ----
  if (req.method === 'GET' && urlPath === '/api/scope/presets') {
    var presetsPath = path.join(ROOT, 'scope-presets.json')
    fs.readFile(presetsPath, 'utf8', function (err, data) {
      if (err) return jsonResponse(res, 200, [])
      try { jsonResponse(res, 200, JSON.parse(data)) }
      catch (e) { jsonResponse(res, 200, []) }
    })
    return
  }

  // ---- API: Apply Scope preset ----
  if (req.method === 'POST' && urlPath === '/api/scope/preset') {
    readBody(req, function (body) {
      try {
        var preset = JSON.parse(body)
        var scopeBase = getScopeUrl()
        if (!scopeBase) return jsonResponse(res, 400, { error: 'No Scope URL' })
        var scopeIsHttps = scopeBase.startsWith('https')
        var scopeLib = scopeIsHttps ? https : http

        // Load pipeline with full config
        var loadParams = {}
        if (preset.width) loadParams.width = preset.width
        if (preset.height) loadParams.height = preset.height
        if (preset.loras) loadParams.loras = preset.loras
        if (preset.vace_enabled !== undefined) loadParams.vace_enabled = preset.vace_enabled
        if (preset.vace_context_scale !== undefined) loadParams.vace_context_scale = preset.vace_context_scale

        var postData = JSON.stringify({
          pipeline_ids: [preset.pipeline || 'krea-realtime-video'],
          load_params: loadParams
        })
        var urlObj = new URL(scopeBase + '/api/v1/pipeline/load')
        var opts = {
          hostname: urlObj.hostname, port: urlObj.port || (scopeIsHttps ? 443 : 80),
          path: urlObj.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        }
        var req2 = scopeLib.request(opts, function (r) {
          var chunks = []
          r.on('data', function (c) { chunks.push(c) })
          r.on('end', function () {
            console.log('  Scope preset: pipeline load →', r.statusCode, '(' + (preset.name || preset.pipeline) + ')')
            // Pipeline loading is async — the prompt and output_sinks
            // will be applied by the user via the Scope UI once loaded
            jsonResponse(res, 200, {
              applied: true,
              pipeline: preset.pipeline,
              name: preset.name,
              note: 'Pipeline loading — apply prompt and outputs after it finishes loading'
            })
          })
        })
        req2.on('error', function (e) { jsonResponse(res, 500, { error: e.message }) })
        req2.write(postData)
        req2.end()
      } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON: ' + e.message })
      }
    })
    return
  }

  // ---- API: Daydream status ----
  if (req.method === 'GET' && urlPath === '/api/daydream/status') {
    var key = getDaydreamKey()
    var scope = getScopeUrl()
    jsonResponse(res, 200, { available: !!(key || scope), hasCloud: !!key, hasScope: !!scope, scopeUrl: scope || null })
    return
  }

  // ---- API: Scope OSC UDP relay ----
  // POST /api/scope-osc  body: {key, value, type}
  // Encodes and sends an OSC message to Scope's UDP port (same as HTTP port).
  if (req.method === 'POST' && urlPath === '/api/scope-osc') {
    var scopeUrlForOsc = getScopeUrl()
    if (!scopeUrlForOsc) { console.log('  OSC: no Scope URL'); return jsonResponse(res, 400, { error: 'No Scope URL' }) }
    readBody(req, function (oscBody) {
      try {
        var oscData = JSON.parse(oscBody)
        var oscKey = oscData.key
        var oscValue = oscData.value
        var oscType = oscData.type || 'float'
        // If key starts with '/', use as-is; otherwise prefix with /scope/
        var oscAddress = oscKey.charAt(0) === '/' ? oscKey : '/scope/' + oscKey
        console.log('  OSC →', oscAddress, oscValue)
        // Encode OSC string (null-terminated, padded to 4 bytes)
        function encodeOscStr (s) {
          var b = Buffer.from(s + '\0', 'utf8')
          var pad = (4 - (b.length % 4)) % 4
          return Buffer.concat([b, Buffer.alloc(pad)])
        }
        var addrBuf = encodeOscStr(oscAddress)
        var tagBuf, valBuf
        if (oscType === 'float' || oscType === 'number') {
          tagBuf = encodeOscStr(',f')
          valBuf = Buffer.alloc(4); valBuf.writeFloatBE(parseFloat(oscValue), 0)
        } else if (oscType === 'int' || oscType === 'integer') {
          tagBuf = encodeOscStr(',i')
          valBuf = Buffer.alloc(4); valBuf.writeInt32BE(parseInt(oscValue), 0)
        } else if (oscType === 'string') {
          tagBuf = encodeOscStr(',s')
          valBuf = encodeOscStr(String(oscValue))
        } else if (oscType === 'int_list') {
          var intArr = Array.isArray(oscValue) ? oscValue : JSON.parse(oscValue)
          tagBuf = encodeOscStr(',' + intArr.map(function () { return 'i' }).join(''))
          var bufs = intArr.map(function (n) { var b = Buffer.alloc(4); b.writeInt32BE(parseInt(n), 0); return b })
          valBuf = Buffer.concat(bufs)
        } else {
          return jsonResponse(res, 400, { error: 'Unknown type: ' + oscType })
        }
        var oscMsg = Buffer.concat([addrBuf, tagBuf, valBuf])
        var oscUrlParsed = new URL(scopeUrlForOsc)
        var oscHost = oscUrlParsed.hostname
        var oscPort = parseInt(oscUrlParsed.port) || 8000
        var dgram = require('dgram')
        var sock = dgram.createSocket('udp4')
        sock.send(oscMsg, oscPort, oscHost, function (err) {
          sock.close()
          if (err) { jsonResponse(res, 502, { error: err.message }) }
          else { jsonResponse(res, 200, { ok: true, address: oscAddress, value: oscValue }) }
        })
      } catch (e) { jsonResponse(res, 500, { error: e.message }) }
    })
    return
  }

  // ---- API: Scope proxy (forward requests to Scope — local or remote) ----
  if (urlPath.startsWith('/api/scope/')) {
    var scopeBase = getScopeUrl()
    if (!scopeBase) {
      console.log('  Scope proxy: no URL configured')
      return jsonResponse(res, 400, { error: 'No Scope URL configured' })
    }
    console.log('  Scope proxy: ' + req.method + ' ' + urlPath + ' → ' + scopeBase)
    var scopePath = urlPath.replace('/api/scope', '')
    var scopeUrlObj = new URL(scopeBase + scopePath)
    var scopeIsHttps = scopeUrlObj.protocol === 'https:'
    var scopeLib = scopeIsHttps ? https : http
    var scopeOpts = {
      hostname: scopeUrlObj.hostname,
      port: scopeUrlObj.port || (scopeIsHttps ? 443 : 80),
      path: scopeUrlObj.pathname + (scopeUrlObj.search || ''),
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
      rejectUnauthorized: false
    }
    if (req.method === 'GET') {
      var scopeReq = scopeLib.request(scopeOpts, function (scopeRes) {
        var chunks = []
        scopeRes.on('data', function (c) { chunks.push(c) })
        scopeRes.on('end', function () {
          var responseBody = Buffer.concat(chunks).toString()
          console.log('  Scope proxy: ← ' + scopeRes.statusCode + ' (' + responseBody.length + ' bytes)')
          res.writeHead(scopeRes.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
          res.end(responseBody)
        })
      })
      scopeReq.setTimeout(10000, function () { scopeReq.destroy(); jsonResponse(res, 504, { error: 'Scope timeout' }) })
      scopeReq.on('error', function (err) {
        console.log('  Scope proxy: ERROR ' + err.message)
        if (!res.headersSent) jsonResponse(res, 502, { error: err.message })
      })
      scopeReq.end()
    } else {
      readBody(req, function (body) {
        if (body) {
          scopeOpts.headers['Content-Length'] = Buffer.byteLength(body)
          console.log('  Scope proxy: → body ' + body.length + ' bytes')
        }
        var scopeReq = scopeLib.request(scopeOpts, function (scopeRes) {
          var chunks = []
          scopeRes.on('data', function (c) { chunks.push(c) })
          scopeRes.on('end', function () {
            var responseBody = Buffer.concat(chunks).toString()
            console.log('  Scope proxy: ← ' + scopeRes.statusCode + ' (' + responseBody.length + ' bytes)')
            res.writeHead(scopeRes.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
            res.end(responseBody)
          })
        })
        scopeReq.setTimeout(10000, function () { scopeReq.destroy(); jsonResponse(res, 504, { error: 'Scope timeout' }) })
        scopeReq.on('error', function (err) {
          console.log('  Scope proxy: ERROR ' + err.message)
          if (!res.headersSent) jsonResponse(res, 502, { error: err.message })
        })
        if (body) scopeReq.write(body)
        scopeReq.end()
      })
    }
    return
  }

  // ---- API: Daydream create stream ----
  if (req.method === 'POST' && urlPath === '/api/daydream/stream') {
    readBody(req, function (body) {
      try {
        var data = JSON.parse(body)
        var prompt = data.prompt || 'abstract fluid art'
        var modelId = data.model_id || 'stabilityai/sdxl-turbo'
        var params = { model_id: modelId, prompt: prompt }
        // Pass through any extra params (lora_dict, controlnets, etc.)
        var passthrough = ['lora_dict', 'controlnets', 'ip_adapter', 'negative_prompt',
          'guidance_scale', 'delta', 'seed', 'width', 'height', 'use_lcm_lora']
        passthrough.forEach(function (k) { if (data[k] !== undefined) params[k] = data[k] })
        daydreamRequest('POST', '/v1/streams', {
          pipeline: 'streamdiffusion',
          params: params
        }).then(function (r) {
          // Store stream ID so TD bridge can update it
          if (r.data && r.data.id) {
            activeDaydreamStreamId = r.data.id
            activeDaydreamPlaybackId = r.data.output_playback_id || null
            console.log('  Daydream stream created:', activeDaydreamStreamId)
          }
          jsonResponse(res, r.status, r.data)
        }).catch(function (err) {
          jsonResponse(res, 500, { error: err.message })
        })
      } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON' })
      }
    })
    return
  }

  // ---- API: Daydream update stream ----
  if (req.method === 'PATCH' && urlPath === '/api/daydream/stream') {
    readBody(req, function (body) {
      try {
        var data = JSON.parse(body)
        if (!data.id) return jsonResponse(res, 400, { error: 'id required' })
        daydreamRequest('PATCH', '/v1/streams/' + data.id, {
          pipeline: 'streamdiffusion',
          params: data.params || {}
        }).then(function (r) {
          jsonResponse(res, r.status, r.data)
        }).catch(function (err) {
          jsonResponse(res, 500, { error: err.message })
        })
      } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON' })
      }
    })
    return
  }

  // ---- API: TD → Daydream bridge ----
  // Uses the shared activeDaydreamStreamId set by the browser's create endpoint.
  // TD sends: POST /api/td/daydream {action: "update"|"status", prompt, guidance_scale, ...}
  // Browser creates the stream (WHIP/WHEP), TD updates params on it.
  if (req.method === 'POST' && urlPath === '/api/td/daydream') {
    readBody(req, function (body) {
      try {
        var data = JSON.parse(body)
        var action = data.action || 'update'

        if (action === 'update') {
          if (!activeDaydreamStreamId) return jsonResponse(res, 400, { error: 'No active stream. Connect from browser first.' })
          var updateParams = {}
          if (data.prompt !== undefined) updateParams.prompt = data.prompt
          if (data.model_id !== undefined) updateParams.model_id = data.model_id
          if (data.guidance_scale !== undefined) updateParams.guidance_scale = data.guidance_scale
          if (data.negative_prompt !== undefined) updateParams.negative_prompt = data.negative_prompt
          if (data.seed !== undefined) updateParams.seed = data.seed
          daydreamRequest('PATCH', '/v1/streams/' + activeDaydreamStreamId, {
            pipeline: 'streamdiffusion',
            params: updateParams
          }).then(function (r) {
            console.log('  TD bridge: prompt updated →', updateParams.prompt || '(no prompt change)')
            jsonResponse(res, r.status, r.data)
          }).catch(function (err) {
            jsonResponse(res, 500, { error: err.message })
          })

        } else if (action === 'status') {
          jsonResponse(res, 200, {
            active: !!activeDaydreamStreamId,
            streamId: activeDaydreamStreamId,
            playbackId: activeDaydreamPlaybackId
          })

        } else {
          jsonResponse(res, 400, { error: 'Use browser to create/stop streams. TD can only update and check status.' })
        }
      } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON' })
      }
    })
    return
  }

  // ---- API: Daydream stop stream ----
  if (req.method === 'POST' && urlPath === '/api/daydream/stop') {
    readBody(req, function (body) {
      try {
        var data = JSON.parse(body)
        if (!data.id) return jsonResponse(res, 400, { error: 'id required' })
        daydreamRequest('DELETE', '/v1/streams/' + data.id).then(function (r) {
          activeDaydreamStreamId = null
          activeDaydreamPlaybackId = null
          console.log('  Daydream stream stopped:', data.id)
          jsonResponse(res, r.status, r.data || { stopped: true })
        }).catch(function (err) {
          jsonResponse(res, 500, { error: err.message })
        })
      } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON' })
      }
    })
    return
  }

  // ---- API: ProRes recording — start session ----
  if (req.method === 'POST' && urlPath === '/api/recordings/start') {
    readBody(req, function (body) {
      try {
        var data = JSON.parse(body)
        var fps = data.fps || 16
        var w = data.width || 1920
        var h = data.height || 1080
        var folderName = (data.folder || '').replace(/[^a-zA-Z0-9_-]/g, '')
        var saveDir = folderName ? path.join(RECORDINGS_DIR, folderName) : RECORDINGS_DIR
        try { fs.mkdirSync(saveDir, { recursive: true }) } catch (e) {}

        var d = new Date()
        var ts = d.getFullYear() + '-' +
          String(d.getMonth() + 1).padStart(2, '0') + '-' +
          String(d.getDate()).padStart(2, '0') + '_' +
          String(d.getHours()).padStart(2, '0') + '.' +
          String(d.getMinutes()).padStart(2, '0') + '.' +
          String(d.getSeconds()).padStart(2, '0')
        var filename = 'hydra-' + ts + '.mov'
        var filePath = path.join(saveDir, filename)
        var sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

        // Spawn ffmpeg: read raw RGBA frames from stdin, encode ProRes LT
        var ffArgs = [
          '-y',
          '-f', 'rawvideo',
          '-pix_fmt', 'rgba',
          '-s', w + 'x' + h,
          '-r', String(fps),
          '-i', '-',
          '-c:v', 'prores_ks',
          '-profile:v', '1',  // 0=Proxy, 1=LT, 2=Standard, 3=HQ
          '-pix_fmt', 'yuv422p10le',
          '-an',
          filePath
        ]
        var ffmpeg = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
        ffmpeg.stderr.on('data', function (d) {
          // Suppress normal ffmpeg output, log errors
          var line = d.toString().trim()
          if (line.includes('Error') || line.includes('error')) console.log('  ffmpeg: ' + line)
        })
        ffmpeg.on('error', function (err) {
          console.log('  ffmpeg spawn error: ' + err.message)
        })

        recSessions[sessionId] = {
          ffmpeg: ffmpeg,
          filePath: filePath,
          filename: filename,
          folder: folderName,
          frameCount: 0
        }
        console.log('  Recording started: ' + (folderName ? folderName + '/' : '') + filename + ' (' + w + 'x' + h + ' @ ' + fps + 'fps ProRes LT)')
        jsonResponse(res, 200, { sessionId: sessionId, filename: filename })
      } catch (e) {
        jsonResponse(res, 400, { error: e.message })
      }
    })
    return
  }

  // ---- API: ProRes recording — receive frame ----
  if (req.method === 'POST' && urlPath.startsWith('/api/recordings/frame/')) {
    var frameSid = path.basename(urlPath)
    var session = recSessions[frameSid]
    if (!session) return jsonResponse(res, 404, { error: 'No active session' })
    var frameChunks = []
    req.on('data', function (c) { frameChunks.push(c) })
    req.on('end', function () {
      var frameBuf = Buffer.concat(frameChunks)
      if (session.ffmpeg && session.ffmpeg.stdin.writable) {
        session.ffmpeg.stdin.write(frameBuf)
        session.frameCount++
      }
      jsonResponse(res, 200, { ok: true, frame: session.frameCount })
    })
    return
  }

  // ---- API: ProRes recording — stop session ----
  if (req.method === 'POST' && urlPath.startsWith('/api/recordings/stop/')) {
    var stopSid = path.basename(urlPath)
    var stopSession = recSessions[stopSid]
    if (!stopSession) return jsonResponse(res, 404, { error: 'No active session' })
    delete recSessions[stopSid]

    // Close stdin to signal ffmpeg to finalize
    stopSession.ffmpeg.stdin.end()
    stopSession.ffmpeg.on('close', function (code) {
      if (code !== 0) {
        console.log('  ffmpeg exited with code ' + code)
        return jsonResponse(res, 500, { error: 'ffmpeg exited with code ' + code })
      }
      try {
        var stat = fs.statSync(stopSession.filePath)
        var sizeMB = (stat.size / (1024 * 1024)).toFixed(1)
        var relPath = stopSession.folder ? stopSession.folder + '/' + stopSession.filename : stopSession.filename
        console.log('  Recording saved: ' + relPath + ' (' + sizeMB + ' MB, ' + stopSession.frameCount + ' frames)')
        jsonResponse(res, 200, { saved: stopSession.filename, folder: stopSession.folder || null, size: stat.size, frames: stopSession.frameCount, path: 'recordings/' + relPath })
      } catch (e) {
        jsonResponse(res, 500, { error: 'File stat failed: ' + e.message })
      }
    })
    return
  }

  // ---- API: settings ----
  if (req.method === 'GET' && urlPath === '/api/settings') {
    jsonResponse(res, 200, loadSettings())
    return
  }
  if (req.method === 'PATCH' && urlPath === '/api/settings') {
    var sChunks = []
    req.on('data', function (c) { sChunks.push(c) })
    req.on('end', function () {
      try {
        var patch = JSON.parse(Buffer.concat(sChunks).toString())
        var updated = saveSettings(patch)
        console.log('  Settings updated:', Object.keys(patch).join(', '))
        jsonResponse(res, 200, updated)
      } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON: ' + e.message })
      }
    })
    return
  }

  // ---- API: notes (scope notes + prompt scenes persisted to disk) ----
  var NOTES_FILE = path.join(__dirname, 'scope-notes.json')
  if (req.method === 'GET' && urlPath === '/api/notes') {
    try {
      var data = fs.existsSync(NOTES_FILE) ? JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')) : {}
      jsonResponse(res, 200, data)
    } catch (e) {
      jsonResponse(res, 200, {})
    }
    return
  }
  if (req.method === 'PUT' && urlPath === '/api/notes') {
    var nChunks = []
    req.on('data', function (c) { nChunks.push(c) })
    req.on('end', function () {
      try {
        var body = JSON.parse(Buffer.concat(nChunks).toString())
        fs.writeFileSync(NOTES_FILE, JSON.stringify(body, null, 2))
        jsonResponse(res, 200, { ok: true })
      } catch (e) {
        jsonResponse(res, 400, { error: 'Invalid JSON: ' + e.message })
      }
    })
    return
  }

  // ---- API: save frame (canvas screenshot as PNG) ----
  if (req.method === 'POST' && urlPath === '/api/frame') {
    var frameDir = getCaptureDir()
    // Optional ?name=xxx query param for custom filename
    var fqp = req.url.split('?')[1] || ''
    var frameName = ''
    fqp.split('&').forEach(function (p) {
      var kv = p.split('=')
      if (kv[0] === 'name') frameName = decodeURIComponent(kv[1] || '')
    })
    frameName = frameName.replace(/[^a-zA-Z0-9_-]/g, '')
    var fChunks = []
    req.on('data', function (c) { fChunks.push(c) })
    req.on('end', function () {
      var imgBuf = Buffer.concat(fChunks)
      var d = new Date()
      var fTs = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + '_' +
        String(d.getHours()).padStart(2, '0') + '.' +
        String(d.getMinutes()).padStart(2, '0') + '.' +
        String(d.getSeconds()).padStart(2, '0')
      var fFilename = (frameName || 'frame-' + fTs) + '.png'
      var fPath = path.join(frameDir, fFilename)
      fs.writeFile(fPath, imgBuf, function (err) {
        if (err) return jsonResponse(res, 500, { error: 'Write failed: ' + err.message })
        console.log('  Frame saved: ' + fPath + ' (' + (imgBuf.length / 1024).toFixed(0) + ' KB)')
        jsonResponse(res, 200, { saved: fFilename, path: fPath })
      })
    })
    return
  }

  // ---- API: save recording (legacy H.264 upload) ----
  if (req.method === 'POST' && urlPath === '/api/recordings') {
    // Optional ?folder=batch-xxx subfolder for batch recordings
    var qp = req.url.split('?')[1] || ''
    var folderParam = ''
    qp.split('&').forEach(function (p) {
      var kv = p.split('=')
      if (kv[0] === 'folder') folderParam = decodeURIComponent(kv[1] || '')
    })
    // Sanitize folder name — alphanumeric, dashes, underscores only
    folderParam = folderParam.replace(/[^a-zA-Z0-9_-]/g, '')
    var saveDir = folderParam ? path.join(RECORDINGS_DIR, folderParam) : RECORDINGS_DIR
    try { fs.mkdirSync(saveDir, { recursive: true }) } catch (e) {}
    var chunks = []
    req.on('data', function (c) { chunks.push(c) })
    req.on('end', function () {
      var blob = Buffer.concat(chunks)
      var contentType = req.headers['content-type'] || ''
      var ext = contentType.includes('mp4') ? '.mp4' : '.webm'
      var d = new Date()
      var ts = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + '_' +
        String(d.getHours()).padStart(2, '0') + '.' +
        String(d.getMinutes()).padStart(2, '0') + '.' +
        String(d.getSeconds()).padStart(2, '0')
      var filename = 'hydra-' + ts + ext
      var filePath = path.join(saveDir, filename)
      var relPath = folderParam ? folderParam + '/' + filename : filename
      fs.writeFile(filePath, blob, function (err) {
        if (err) return jsonResponse(res, 500, { error: 'Write failed: ' + err.message })
        var sizeMB = (blob.length / (1024 * 1024)).toFixed(1)
        console.log('  Recording saved: ' + relPath + ' (' + sizeMB + ' MB)')
        jsonResponse(res, 200, { saved: filename, folder: folderParam || null, size: blob.length, path: 'recordings/' + relPath })
      })
    })
    return
  }

  // ---- API: list recordings ----
  if (req.method === 'GET' && urlPath === '/api/recordings') {
    fs.readdir(RECORDINGS_DIR, function (err, files) {
      if (err) return jsonResponse(res, 200, [])
      var recordings = files
        .filter(function (f) { return /\.(mp4|webm)$/i.test(f) })
        .sort()
        .reverse()
        .map(function (f) {
          var stat = fs.statSync(path.join(RECORDINGS_DIR, f))
          return { file: f, size: stat.size, date: stat.mtime }
        })
      jsonResponse(res, 200, recordings)
    })
    return
  }

  // ---- Static files ----
  if (urlPath === '/') urlPath = '/dist/launcher.html'
  var staticPath = path.join(ROOT, urlPath)
  if (!staticPath.startsWith(ROOT)) {
    res.writeHead(403)
    res.end()
    return
  }

  var ext = path.extname(staticPath).toLowerCase()

  // Stream video files with range request support
  if (ext === '.mp4' || ext === '.webm' || ext === '.mov') {
    fs.stat(staticPath, function (err, stat) {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
        return
      }
      var total = stat.size
      var range = req.headers.range
      if (range) {
        var parts = range.replace(/bytes=/, '').split('-')
        var start = parseInt(parts[0], 10)
        var end = parts[1] ? parseInt(parts[1], 10) : total - 1
        res.writeHead(206, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': MIME[ext] || 'application/octet-stream'
        })
        fs.createReadStream(staticPath, { start: start, end: end }).pipe(res)
      } else {
        res.writeHead(200, {
          'Content-Length': total,
          'Accept-Ranges': 'bytes',
          'Content-Type': MIME[ext] || 'application/octet-stream'
        })
        fs.createReadStream(staticPath).pipe(res)
      }
    })
    return
  }

  fs.readFile(staticPath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    })
    res.end(data)
  })
})

// WebSocket relay — launcher sends code, all other clients receive it
var wss = new WsServer({ noServer: true })

// Recording frame WebSocket — receives raw RGBA pixel data
var recWss = new WsServer({ noServer: true })
recWss.on('connection', function (ws, req) {
  var urlParts = req.url.split('/')
  var sessionId = urlParts[urlParts.length - 1]
  var session = recSessions[sessionId]
  if (!session) { ws.close(); return }
  console.log('  Recording WS connected: ' + sessionId)
  ws.on('message', function (data) {
    if (session.ffmpeg && session.ffmpeg.stdin.writable) {
      session.ffmpeg.stdin.write(Buffer.from(data))
      session.frameCount++
    }
  })
  ws.on('close', function () {
    console.log('  Recording WS closed: ' + sessionId + ' (' + session.frameCount + ' frames)')
  })
})

// Route WebSocket upgrades
server.on('upgrade', function (req, socket, head) {
  if (req.url && req.url.startsWith('/ws/recording/')) {
    recWss.handleUpgrade(req, socket, head, function (ws) {
      recWss.emit('connection', ws, req)
    })
  } else {
    wss.handleUpgrade(req, socket, head, function (ws) {
      wss.emit('connection', ws, req)
    })
  }
})
var lastCode = null
var lastWarp = null
var linkEnabled = false
var linkBroadcastTimer = null

function startLinkBroadcast () {
  if (linkBroadcastTimer || !link) return
  linkBroadcastTimer = setInterval(function () {
    if (!linkEnabled) return
    try {
      var msg = JSON.stringify({
        type: 'link',
        bpm: Math.round(link.bpm * 100) / 100,
        beat: Math.round(link.beat * 1000) / 1000,
        phase: Math.round(link.phase * 1000) / 1000,
        numPeers: link.numPeers
      })
      wss.clients.forEach(function (client) {
        if (client.readyState === 1) client.send(msg)
      })
    } catch (err) {
      console.error('Link broadcast error:', err.message)
    }
  }, 50) // ~20Hz updates
}

function stopLinkBroadcast () {
  if (linkBroadcastTimer) {
    clearInterval(linkBroadcastTimer)
    linkBroadcastTimer = null
  }
}

wss.on('connection', function (ws) {
  if (lastCode) ws.send(lastCode)
  if (lastWarp) ws.send(lastWarp)

  // Send current link status on connect
  if (link) {
    try {
      ws.send(JSON.stringify({
        type: 'link-status',
        available: true,
        enabled: linkEnabled,
        bpm: Math.round(link.bpm * 100) / 100,
        numPeers: link.numPeers
      }))
    } catch (err) { console.error('Link status send error:', err.message) }
  } else {
    ws.send(JSON.stringify({ type: 'link-status', available: false }))
  }

  ws.on('message', function (msg) {
    var str = msg.toString()
    try {
      var data = JSON.parse(str)
      // Handle Link control messages
      if (data.type === 'link-enable' && link) {
        linkEnabled = true
        try { link.enable() } catch (err) { console.error('Link enable error:', err.message) }
        startLinkBroadcast()
        return
      }
      if (data.type === 'link-disable' && link) {
        linkEnabled = false
        try { link.disable() } catch (err) { console.error('Link disable error:', err.message) }
        stopLinkBroadcast()
        wss.clients.forEach(function (client) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'link', enabled: false }))
          }
        })
        return
      }
      if (data.type === 'link-set-bpm' && link && linkEnabled) {
        try { link.bpm = Math.max(20, Math.min(999, data.bpm)) } catch (err) { console.error('Link set-bpm error:', err.message) }
        return
      }
    } catch (e) {}

    // Regular code/warp relay
    try {
      var parsed = JSON.parse(str)
      if (parsed.type === 'warp-update') {
        lastWarp = str
      } else if (parsed.type === 'map-mode') {
        // Transient — relay but don't cache (output defaults to live)
      } else {
        lastCode = str
      }
    } catch (e) {
      lastCode = str
    }
    wss.clients.forEach(function (client) {
      if (client !== ws && client.readyState === 1) {
        client.send(str)
      }
    })
  })
})

server.listen(PORT, function () {
  console.log('')
  console.log('  Hydra relay server running on port ' + PORT)
  console.log('')
  console.log('  Launcher:  http://localhost:' + PORT + '/')
  console.log('  Output:    http://localhost:' + PORT + '/dist/output.html')
  console.log('  TD output: http://localhost:' + PORT + '/dist/td-output.html')
  console.log('')
  var startSettings = loadSettings()
  console.log('  Settings: ' + (fs.existsSync(SETTINGS_PATH) ? SETTINGS_PATH : 'using defaults'))
  console.log('  Captures: ' + expandHome(startSettings.captureDir || '~/HydraVJ/frames'))
  console.log('')
  console.log('  API:')
  console.log('    GET    /api/settings          — read settings')
  console.log('    PATCH  /api/settings          — update settings')
  console.log('    GET    /api/presets          — list saved presets')
  console.log('    GET    /api/presets/:file     — load a preset')
  console.log('    POST   /api/presets           — save {name, code}')
  console.log('    DELETE /api/presets/:file     — archive a preset')
  console.log('    GET    /api/recordings       — list recordings')
  console.log('    POST   /api/recordings       — save recording (binary body)')
  console.log('')
  var ddKey = getDaydreamKey()
  if (ddKey) {
    console.log('  Daydream: API key loaded (' + ddKey.substring(0, 8) + '...)')
    console.log('    POST   /api/daydream/stream  — create AI stream')
    console.log('    PATCH  /api/daydream/stream  — update prompt/model')
    console.log('    POST   /api/daydream/stop    — stop stream')
    console.log('    POST   /api/td/daydream      — TD bridge (create/update/stop/status)')
  } else {
    console.log('  Daydream: No API key (create daydream.config.json or set DAYDREAM_API_KEY)')
  }
  console.log('')
})
