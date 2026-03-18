// Gray-Scott Reaction-Diffusion — standalone WebGL CA engine
// Hydra-style API:
//   grayScott(0.037, 0.06).out(o0)

(function () {
  var _engine = null
  var _source = null
  var _prevSynthUpdate = null

  var SIM_VERT = [
    'attribute vec2 a_pos;',
    'varying vec2 v_uv;',
    'void main() {',
    '  v_uv = a_pos * 0.5 + 0.5;',
    '  gl_Position = vec4(a_pos, 0.0, 1.0);',
    '}'
  ].join('\n')

  var SIM_FRAG = [
    'precision highp float;',
    'varying vec2 v_uv;',
    'uniform sampler2D u_state;',
    'uniform vec2 u_texel;',
    'uniform float u_feed;',
    'uniform float u_kill;',
    'uniform float u_dU;',
    'uniform float u_dV;',
    '',
    'void main() {',
    '  vec2 uv = v_uv;',
    '  vec4 c = texture2D(u_state, uv);',
    '  float U = c.r;',
    '  float V = c.g;',
    '',
    '  vec4 n0 = texture2D(u_state, fract(uv + vec2(u_texel.x, 0.0)));',
    '  vec4 n1 = texture2D(u_state, fract(uv + vec2(-u_texel.x, 0.0)));',
    '  vec4 n2 = texture2D(u_state, fract(uv + vec2(0.0, u_texel.y)));',
    '  vec4 n3 = texture2D(u_state, fract(uv + vec2(0.0, -u_texel.y)));',
    '  float lapU = n0.r + n1.r + n2.r + n3.r - 4.0 * U;',
    '  float lapV = n0.g + n1.g + n2.g + n3.g - 4.0 * V;',
    '',
    '  float uvv = U * V * V;',
    '  float newU = U + u_dU * lapU - uvv + u_feed * (1.0 - U);',
    '  float newV = V + u_dV * lapV + uvv - (u_feed + u_kill) * V;',
    '',
    '  gl_FragColor = vec4(clamp(newU, 0.0, 1.0), clamp(newV, 0.0, 1.0), 0.0, 1.0);',
    '}'
  ].join('\n')

  // Render shader: iridescent coloring + emboss + bloom glow
  // Ported from daydream_scope iridescent pipeline
  var RENDER_FRAG = [
    'precision highp float;',
    'varying vec2 v_uv;',
    'uniform sampler2D u_state;',
    'uniform vec2 u_texel;',
    'uniform float u_time;',
    '',
    'vec3 cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {',
    '  vec3 col = a + b * cos(6.28318 * (c * t + d));',
    '  col += 0.06 * cos(6.28318 * (c * 2.5 * t + d + 0.3));',
    '  col += 0.03 * cos(6.28318 * (c * 4.0 * t + d + 0.7));',
    '  return clamp(col, 0.0, 1.0);',
    '}',
    '',
    'void main() {',
    '  vec2 uv = v_uv;',
    '  vec4 c = texture2D(u_state, uv);',
    '  float rawV = c.g;',
    '',
    '  // Bloom: cheap 9-tap gaussian on V before coloring (masks grid)',
    '  float bV = rawV * 0.25;',
    '  bV += texture2D(u_state, fract(uv + vec2(u_texel.x, 0.0))).g * 0.125;',
    '  bV += texture2D(u_state, fract(uv + vec2(-u_texel.x, 0.0))).g * 0.125;',
    '  bV += texture2D(u_state, fract(uv + vec2(0.0, u_texel.y))).g * 0.125;',
    '  bV += texture2D(u_state, fract(uv + vec2(0.0, -u_texel.y))).g * 0.125;',
    '  bV += texture2D(u_state, fract(uv + vec2(u_texel.x, u_texel.y))).g * 0.0625;',
    '  bV += texture2D(u_state, fract(uv + vec2(-u_texel.x, u_texel.y))).g * 0.0625;',
    '  bV += texture2D(u_state, fract(uv + vec2(u_texel.x, -u_texel.y))).g * 0.0625;',
    '  bV += texture2D(u_state, fract(uv + vec2(-u_texel.x, -u_texel.y))).g * 0.0625;',
    '',
    '  // Contrast stretch: GS V is typically 0-0.35',
    '  float V = clamp((bV - 0.015) * 3.5, 0.0, 1.0);',
    '',
    '  // Sobel on smoothed V for clean edges',
    '  float tl = texture2D(u_state, fract(uv + vec2(-u_texel.x, u_texel.y))).g;',
    '  float t0 = texture2D(u_state, fract(uv + vec2(0.0, u_texel.y))).g;',
    '  float tr = texture2D(u_state, fract(uv + vec2(u_texel.x, u_texel.y))).g;',
    '  float ml = texture2D(u_state, fract(uv + vec2(-u_texel.x, 0.0))).g;',
    '  float mr = texture2D(u_state, fract(uv + vec2(u_texel.x, 0.0))).g;',
    '  float bl = texture2D(u_state, fract(uv + vec2(-u_texel.x, -u_texel.y))).g;',
    '  float b0 = texture2D(u_state, fract(uv + vec2(0.0, -u_texel.y))).g;',
    '  float br = texture2D(u_state, fract(uv + vec2(u_texel.x, -u_texel.y))).g;',
    '',
    '  float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;',
    '  float gy = -tl - 2.0*t0 - tr + bl + 2.0*b0 + br;',
    '  float edge = sqrt(gx*gx + gy*gy);',
    '',
    '  // Emboss',
    '  vec3 normal = normalize(vec3(-gx * 5.0, -gy * 5.0, 1.0));',
    '  vec3 light = normalize(vec3(0.4, 0.5, 1.0));',
    '  float emboss = max(dot(normal, light), 0.0);',
    '  vec3 halfDir = normalize(light + vec3(0.0, 0.0, 1.0));',
    '  float spec = pow(max(dot(normal, halfDir), 0.0), 48.0);',
    '',
    '  // Iridescent color',
    '  float hueShift = u_time * 0.015;',
    '  float t_color = fract(V * 0.4 + edge * 0.3 + hueShift);',
    '  vec3 baseColor = cosPalette(t_color,',
    '    vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5),',
    '    vec3(2.5, 1.8, 2.2), vec3(0.0, 0.25, 0.55));',
    '  vec3 edgeColor = cosPalette(fract(edge * 2.0 + V * 0.3 + hueShift + 0.5),',
    '    vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5),',
    '    vec3(2.5, 1.8, 2.2), vec3(0.0, 0.25, 0.55));',
    '',
    '  // Alpha + combine',
    '  float alpha = pow(clamp(V, 0.0, 1.0), 0.85);',
    '  vec3 color = baseColor * emboss * alpha;',
    '  color += edgeColor * edge * 2.0 * alpha;',
    '  color += vec3(0.85, 0.9, 1.0) * spec * alpha * 0.5;',
    '',
    '  // Bloom glow: wider soft halo (additive, like daydream_scope)',
    '  float glow = 0.0;',
    '  for(float dx = -3.0; dx <= 3.0; dx += 1.0) {',
    '    for(float dy = -3.0; dy <= 3.0; dy += 1.0) {',
    '      float w = exp(-(dx*dx + dy*dy) / 8.0);',
    '      glow += texture2D(u_state, fract(uv + vec2(dx, dy) * u_texel * 3.0)).g * w;',
    '    }',
    '  }',
    '  glow /= 16.0;',
    '  glow = clamp((glow - 0.01) * 2.5, 0.0, 1.0);',
    '  vec3 glowColor = cosPalette(fract(glow * 0.5 + hueShift + 0.3),',
    '    vec3(0.5, 0.5, 0.5), vec3(0.5, 0.5, 0.5),',
    '    vec3(2.5, 1.8, 2.2), vec3(0.0, 0.25, 0.55));',
    '  color += glowColor * glow * 0.2;',
    '',
    '  float fade = smoothstep(0.0, 0.05, V + edge * 0.3 + glow * 0.1);',
    '  color *= fade;',
    '',
    '  gl_FragColor = vec4(color, 1.0);',
    '}'
  ].join('\n')

  function createShader(gl, type, src) {
    var s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('gray-scott shader error:', gl.getShaderInfoLog(s))
      gl.deleteShader(s)
      return null
    }
    return s
  }

  function createProgram(gl, vert, frag) {
    var p = gl.createProgram()
    gl.attachShader(p, vert)
    gl.attachShader(p, frag)
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('gray-scott link error:', gl.getProgramInfoLog(p))
      return null
    }
    return p
  }

  function createFBO(gl, w, h) {
    var tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
    var fb = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { tex: tex, fb: fb }
  }

  function seedState(gl, fbo, w, h) {
    var n = w * h * 4
    var pixels = new Uint8Array(n)
    for (var i = 0; i < w * h; i++) {
      var x = (i % w) / w
      var y = Math.floor(i / w) / h
      pixels[i * 4]     = 255  // U = 1.0
      pixels[i * 4 + 1] = 0    // V = 0.0
      pixels[i * 4 + 2] = 0
      pixels[i * 4 + 3] = 255
      var dx = x - 0.5, dy = y - 0.5
      var dist = dx * dx + dy * dy
      var blob = 0.25 * Math.exp(-dist / 0.003)
      if (blob > 0.001) {
        pixels[i * 4 + 1] = Math.round((blob + Math.random() * 0.02) * 255)
        pixels[i * 4]     = Math.round(Math.max(0, (1.0 - blob * 2.0) + Math.random() * 0.01) * 255)
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, fbo.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  }

  function GrayScottEngine(opts) {
    opts = opts || {}
    this.width = opts.width || 512
    this.height = opts.height || 512
    this.stepsPerFrame = opts.steps || 2
    this.feed = opts.feed !== undefined ? opts.feed : 0.037
    this.kill = opts.kill !== undefined ? opts.kill : 0.06
    this.dU = opts.dU !== undefined ? opts.dU : 0.21
    this.dV = opts.dV !== undefined ? opts.dV : 0.105
    this.running = false
    this._ok = false

    this.canvas = document.createElement('canvas')
    this.canvas.width = this.width
    this.canvas.height = this.height

    var gl = this.canvas.getContext('webgl', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true
    })
    this.gl = gl
    if (!gl) { console.error('gray-scott: no WebGL'); return }

    this.quadBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW)

    var simVert = createShader(gl, gl.VERTEX_SHADER, SIM_VERT)
    var simFrag = createShader(gl, gl.FRAGMENT_SHADER, SIM_FRAG)
    if (!simVert || !simFrag) { console.error('gray-scott: shader fail'); return }
    this.simProg = createProgram(gl, simVert, simFrag)
    if (!this.simProg) { console.error('gray-scott: sim link fail'); return }
    this.simLocs = {
      a_pos: gl.getAttribLocation(this.simProg, 'a_pos'),
      u_state: gl.getUniformLocation(this.simProg, 'u_state'),
      u_texel: gl.getUniformLocation(this.simProg, 'u_texel'),
      u_feed: gl.getUniformLocation(this.simProg, 'u_feed'),
      u_kill: gl.getUniformLocation(this.simProg, 'u_kill'),
      u_dU: gl.getUniformLocation(this.simProg, 'u_dU'),
      u_dV: gl.getUniformLocation(this.simProg, 'u_dV')
    }

    var renderFrag = createShader(gl, gl.FRAGMENT_SHADER, RENDER_FRAG)
    if (!renderFrag) { console.error('gray-scott: render shader fail'); return }
    this.renderProg = createProgram(gl, simVert, renderFrag)
    if (!this.renderProg) { console.error('gray-scott: render link fail'); return }
    this.renderLocs = {
      a_pos: gl.getAttribLocation(this.renderProg, 'a_pos'),
      u_state: gl.getUniformLocation(this.renderProg, 'u_state'),
      u_texel: gl.getUniformLocation(this.renderProg, 'u_texel'),
      u_time: gl.getUniformLocation(this.renderProg, 'u_time')
    }
    this._startTime = performance.now()

    this.fbos = [createFBO(gl, this.width, this.height), createFBO(gl, this.width, this.height)]
    this.pingPong = 0
    seedState(gl, this.fbos[0], this.width, this.height)

    for (var fi = 0; fi < 2; fi++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[fi].fb)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        console.error('gray-scott: FBO ' + fi + ' incomplete'); return
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this._ok = true
    console.log('gray-scott: engine OK ' + this.width + 'x' + this.height)
  }

  GrayScottEngine.prototype.step = function () {
    var gl = this.gl
    if (!this._ok) return
    var w = this.width, h = this.height
    gl.useProgram(this.simProg)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf)
    gl.enableVertexAttribArray(this.simLocs.a_pos)
    gl.vertexAttribPointer(this.simLocs.a_pos, 2, gl.FLOAT, false, 0, 0)
    gl.uniform2f(this.simLocs.u_texel, 1.0 / w, 1.0 / h)
    gl.uniform1f(this.simLocs.u_feed, typeof this.feed === 'function' ? this.feed() : this.feed)
    gl.uniform1f(this.simLocs.u_kill, typeof this.kill === 'function' ? this.kill() : this.kill)
    gl.uniform1f(this.simLocs.u_dU, typeof this.dU === 'function' ? this.dU() : this.dU)
    gl.uniform1f(this.simLocs.u_dV, typeof this.dV === 'function' ? this.dV() : this.dV)
    for (var i = 0; i < this.stepsPerFrame; i++) {
      var src = this.fbos[this.pingPong], dst = this.fbos[1 - this.pingPong]
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb)
      gl.viewport(0, 0, w, h)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src.tex)
      gl.uniform1i(this.simLocs.u_state, 0)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      this.pingPong = 1 - this.pingPong
    }
  }

  GrayScottEngine.prototype.render = function () {
    var gl = this.gl
    if (!this._ok) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.useProgram(this.renderProg)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf)
    gl.enableVertexAttribArray(this.renderLocs.a_pos)
    gl.vertexAttribPointer(this.renderLocs.a_pos, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.fbos[this.pingPong].tex)
    gl.uniform1i(this.renderLocs.u_state, 0)
    gl.uniform2f(this.renderLocs.u_texel, 1.0 / this.width, 1.0 / this.height)
    gl.uniform1f(this.renderLocs.u_time, (performance.now() - this._startTime) * 0.001)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.flush()
  }

  GrayScottEngine.prototype.start = function () { this.running = true }
  GrayScottEngine.prototype.stop = function () { this.running = false }
  GrayScottEngine.prototype.tick = function () {
    if (!this.running || !this._ok) return
    this.step()
    this.render()
  }
  GrayScottEngine.prototype.reseed = function () {
    if (!this._ok) return
    seedState(this.gl, this.fbos[0], this.width, this.height)
    this.pingPong = 0
  }
  GrayScottEngine.prototype.setParams = function (opts) {
    if (opts.feed !== undefined) this.feed = opts.feed
    if (opts.kill !== undefined) this.kill = opts.kill
    if (opts.dU !== undefined) this.dU = opts.dU
    if (opts.dV !== undefined) this.dV = opts.dV
    if (opts.steps !== undefined) this.stepsPerFrame = opts.steps
  }

  // ---- Hydra API ----
  window.grayScott = function (feed, kill, dU, dV, steps) {
    var source = window.s0
    if (_engine) _engine.stop()

    _engine = new GrayScottEngine({
      feed: feed, kill: kill, dU: dU, dV: dV, steps: steps
    })
    if (!_engine._ok) {
      console.error('gray-scott: init failed')
      return window.osc(0, 0, 0)
    }

    _engine.start()
    _source = source
    _engine.step()
    _engine.render()

    // Feed canvas into Hydra source — plain init, no texture hacks
    source.init({ src: _engine.canvas, dynamic: true })

    // Per-frame update via window.update (synth.update)
    var prev = window.update
    _prevSynthUpdate = prev
    window.update = function (dt) {
      try { if (_engine) _engine.tick() } catch (e) { console.error('gray-scott tick:', e) }
      if (typeof prev === 'function') prev(dt)
    }

    console.log('gray-scott: running, feed=' + (_engine.feed) + ' kill=' + (_engine.kill))
    return window.src(source)
  }

  Object.defineProperty(window, 'ca', { get: function () { return _engine }, configurable: true })
  window.caReseed = function () { if (_engine) _engine.reseed() }
  window.GrayScottEngine = GrayScottEngine

  // ---- Cleanup: stop all CA activity (WebGL engine + WebSocket stream) ----
  // Call this before switching away from CA to another mode.
  window.cleanupCA = function () {
    // Stop WebGL gray-scott engine
    if (_engine) {
      _engine.stop()
      _engine = null
    }
    // Restore original window.update (remove gray-scott tick from frame loop)
    if (_prevSynthUpdate !== null) {
      window.update = _prevSynthUpdate
      _prevSynthUpdate = null
    }
    // Close Python CA WebSocket stream
    if (_caWs) {
      try { _caWs.close() } catch (e) {}
      _caWs = null
    }
    // Release s0 if it was bound to CA canvas
    if (_source) {
      _source.src = null
      _source.dynamic = false
      _source = null
    }
    console.log('cleanupCA: all CA resources released')
  }

  // ---- Python CA stream (WebSocket) ----
  // Connects to ca-server.py via WebSocket, receives JPEG frames,
  // decodes with createImageBitmap (GPU), draws to canvas, feeds to Hydra.
  var _caWs = null
  var _caCanvas = null
  var _caCtx = null

  window.caStream = function (preset, port) {
    port = port || 9737
    preset = preset || 'reef'
    var source = window.s0

    // Clean up previous connection
    if (_caWs) { try { _caWs.close() } catch (e) {} }

    // Create offscreen 2D canvas for frame rendering
    if (!_caCanvas) {
      _caCanvas = document.createElement('canvas')
      _caCanvas.width = 512
      _caCanvas.height = 512
      _caCtx = _caCanvas.getContext('2d')
    }

    // Init Hydra source with the 2D canvas
    source.init({ src: _caCanvas, dynamic: true })

    var wsUrl = 'ws://localhost:' + port
    console.log('caStream: connecting to ' + wsUrl)

    _caWs = new WebSocket(wsUrl)
    window._caWs = _caWs  // expose for launcher controls
    _caWs.binaryType = 'arraybuffer'

    _caWs.onopen = function () {
      console.log('caStream: connected')
      // Tell server which preset we want (server skips warmup if already on it)
      _caWs.send(JSON.stringify({ type: 'preset', value: preset }))
    }

    _caWs.onmessage = function (event) {
      if (typeof event.data === 'string') {
        // JSON control message
        try {
          var msg = JSON.parse(event.data)
          if (msg.type === 'preset') console.log('caStream: preset = ' + msg.value)
        } catch (e) {}
        return
      }

      // Binary JPEG frame — GPU-accelerated decode
      var blob = new Blob([event.data], { type: 'image/jpeg' })
      createImageBitmap(blob).then(function (bmp) {
        // Resize canvas if needed
        if (_caCanvas.width !== bmp.width || _caCanvas.height !== bmp.height) {
          _caCanvas.width = bmp.width
          _caCanvas.height = bmp.height
        }
        _caCtx.drawImage(bmp, 0, 0)
        bmp.close()
      })
    }

    _caWs.onerror = function () {
      console.error('caStream: connection failed. Start server: python dist/ca-server.py ' + preset)
    }

    _caWs.onclose = function () {
      console.log('caStream: disconnected')
    }

    return window.src(source)
  }

  // Switch preset: caPreset('coral')
  window.caPreset = function (preset) {
    if (_caWs && _caWs.readyState === 1) {
      _caWs.send(JSON.stringify({ type: 'preset', value: preset }))
    }
  }

  // Reseed: caReseed() (works for both WebGL and Python CA)
  var _origReseed = window.caReseed
  window.caReseed = function () {
    if (_caWs && _caWs.readyState === 1) {
      _caWs.send(JSON.stringify({ type: 'reseed' }))
    } else if (_engine) {
      _engine.reseed()
    }
  }
})()
