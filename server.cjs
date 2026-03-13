#!/usr/bin/env node
// Hydra live-coding relay server
// Serves static files + WebSocket code relay + save/load API
//
// Usage: node server.cjs [port]
// Default port: 8080

const http = require('http')
const fs = require('fs')
const path = require('path')
const WsServer = require('ws').Server

// Ableton Link (optional — native addon, install with: npm install abletonlink)
var AbletonLink = null
var link = null
try {
  AbletonLink = require('abletonlink')
  link = new AbletonLink()
  link.bpm = 120
  link.quantum = 4
  console.log('  Ableton Link loaded.')
} catch (e) {
  console.log('  Ableton Link not available (install abletonlink for Link support)')
}

const PORT = parseInt(process.argv[2], 10) || 8080
const ROOT = __dirname
const PRESETS_DIR = path.join(ROOT, 'presets')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown',
  '.woff2': 'font/woff2'
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

  // ---- API: list presets ----
  if (req.method === 'GET' && urlPath === '/api/presets') {
    var indexPath = path.join(PRESETS_DIR, 'index.json')
    fs.readFile(indexPath, 'utf8', function (err, data) {
      if (err) return jsonResponse(res, 500, { error: 'Cannot read index.json' })
      try {
        var entries = JSON.parse(data)
        var presets = entries.map(function (e) {
          return { file: e.file, name: e.name || e.file.replace(/\.md$/, '').replace(/-/g, ' ') }
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
            index.push({ id: slug, name: data.name, file: file })
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

  // ---- Static files ----
  if (urlPath === '/') urlPath = '/dist/launcher.html'
  var staticPath = path.join(ROOT, urlPath)
  if (!staticPath.startsWith(ROOT)) {
    res.writeHead(403)
    res.end()
    return
  }

  fs.readFile(staticPath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    var ext = path.extname(staticPath).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    })
    res.end(data)
  })
})

// WebSocket relay — launcher sends code, all other clients receive it
var wss = new WsServer({ server: server })
var lastCode = null
var linkEnabled = false
var linkBroadcastTimer = null

function startLinkBroadcast () {
  if (linkBroadcastTimer || !link) return
  linkBroadcastTimer = setInterval(function () {
    if (!linkEnabled) return
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

  // Send current link status on connect
  if (link) {
    ws.send(JSON.stringify({
      type: 'link-status',
      available: true,
      enabled: linkEnabled,
      bpm: Math.round(link.bpm * 100) / 100,
      numPeers: link.numPeers
    }))
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
        link.enable()
        startLinkBroadcast()
        return
      }
      if (data.type === 'link-disable' && link) {
        linkEnabled = false
        link.disable()
        stopLinkBroadcast()
        wss.clients.forEach(function (client) {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'link', enabled: false }))
          }
        })
        return
      }
      if (data.type === 'link-set-bpm' && link && linkEnabled) {
        link.bpm = Math.max(20, Math.min(999, data.bpm))
        return
      }
    } catch (e) {}

    // Regular code relay
    lastCode = str
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
  console.log('  API:')
  console.log('    GET    /api/presets          — list saved presets')
  console.log('    GET    /api/presets/:file     — load a preset')
  console.log('    POST   /api/presets           — save {name, code}')
  console.log('    DELETE /api/presets/:file     — archive a preset')
  console.log('')
})
