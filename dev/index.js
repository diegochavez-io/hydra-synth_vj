const Hydra = require('./../')

const NUM_MOOCS = 12
const SLOTS_PER_MOOC = 12
const NUM_SLIDERS = 5
const STORAGE_KEY = 'hydra-launch-ui-v1'

function clamp01 (value) {
  return Math.max(0, Math.min(1, value))
}

function defaultCode (moocIndex, slotIndex) {
  if (slotIndex === 0) {
    const output = moocIndex % 4
    return [
      `osc(2 + p(1) * 30, 0.01 + p(2) * 0.2, 1 + p(3) * 2)`,
      `  .kaleid(2 + Math.floor(p(4) * 8))`,
      `  .color(0.4 + p(5), 0.4 + p(2), 0.6 + p(3))`,
      `  .out(o${output})`,
      `render(o${output})`
    ].join('\n')
  }

  if (slotIndex === 1) {
    return [
      `src(o0)`,
      `  .modulate(noise(2 + p(1) * 8), 0.02 + p(2) * 0.15)`,
      `  .rotate(() => time * (0.02 + p(3) * 0.2))`,
      `  .saturate(1 + p(4) * 2)`,
      `  .out(o0)`,
      `render(o0)`
    ].join('\n')
  }

  return ''
}

function buildInitialState () {
  const bins = []
  const playheads = []
  const armed = []
  const selectedSlots = []

  for (let m = 0; m < NUM_MOOCS; m += 1) {
    bins[m] = []
    playheads[m] = 0
    armed[m] = true
    selectedSlots[m] = 0
    for (let s = 0; s < SLOTS_PER_MOOC; s += 1) {
      bins[m][s] = defaultCode(m, s)
    }
  }

  return {
    bins,
    playheads,
    armed,
    selectedSlots,
    sliders: new Array(NUM_SLIDERS).fill(0.5)
  }
}

function loadState () {
  const fallback = buildInitialState()

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback

    return {
      bins: Array.isArray(parsed.bins) ? parsed.bins : fallback.bins,
      playheads: Array.isArray(parsed.playheads) ? parsed.playheads : fallback.playheads,
      armed: Array.isArray(parsed.armed) ? parsed.armed : fallback.armed,
      selectedSlots: Array.isArray(parsed.selectedSlots) ? parsed.selectedSlots : fallback.selectedSlots,
      sliders: Array.isArray(parsed.sliders) ? parsed.sliders : fallback.sliders
    }
  } catch (error) {
    console.warn('Failed to load launcher state:', error)
    return fallback
  }
}

function saveState (state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function initLayout () {
  document.body.innerHTML = ''

  const style = document.createElement('style')
  style.textContent = `
    :root {
      --bg: #090f16;
      --panel: #121a25;
      --panel-2: #0f151f;
      --line: #24354f;
      --text: #d7e2f3;
      --muted: #8e9cb2;
      --accent: #3ecf8e;
      --accent-2: #ff8c42;
      --danger: #f06a6a;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; background: radial-gradient(circle at 20% 0%, #132237, var(--bg) 50%); color: var(--text); font-family: "IBM Plex Sans", "Segoe UI", sans-serif; }
    #app { display: flex; width: 100%; height: 100%; gap: 10px; padding: 10px; }
    #stage { flex: 1 1 auto; min-width: 340px; border: 1px solid var(--line); background: #000; border-radius: 10px; overflow: hidden; position: relative; }
    #stage canvas { width: 100%; height: 100%; display: block; }
    #panel { width: min(48vw, 640px); min-width: 420px; border: 1px solid var(--line); border-radius: 10px; background: linear-gradient(180deg, var(--panel), var(--panel-2)); display: flex; flex-direction: column; }
    #toolbar { padding: 12px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
    #toolbarRow { display: flex; gap: 8px; }
    .btn { border: 1px solid var(--line); background: #1b2533; color: var(--text); padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; }
    .btn:hover { border-color: var(--accent); }
    .btn.main { background: linear-gradient(90deg, #2f784f, #276f4e); border-color: #3ea16f; font-weight: 700; }
    .btn.warn { background: linear-gradient(90deg, #7f4a2a, #6d3e25); border-color: #bb7141; }
    #status { font-size: 12px; color: var(--muted); min-height: 1.2em; }
    #sliders { padding: 12px; border-bottom: 1px solid var(--line); display: grid; gap: 6px; }
    .sliderRow { display: grid; grid-template-columns: 36px 1fr 50px; gap: 8px; align-items: center; font-size: 12px; color: var(--muted); }
    .sliderRow input[type="range"] { width: 100%; accent-color: var(--accent); }
    .sliderValue { text-align: right; color: var(--text); font-variant-numeric: tabular-nums; }
    #moocList { overflow: auto; padding: 12px; display: grid; gap: 10px; }
    .moocCard { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #121a25; display: grid; gap: 8px; }
    .moocTop { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted); }
    .moocTitle { font-size: 13px; color: var(--text); font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .padGrid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; }
    .pad { border: 1px solid var(--line); border-radius: 6px; background: #1a2331; color: var(--text); font-size: 11px; padding: 6px 0; cursor: pointer; }
    .pad:hover { border-color: var(--accent-2); }
    .pad.selected { border-color: #7ca7ff; background: #223049; }
    .pad.playhead { border-color: var(--accent); background: #1f3b31; }
    .pad.empty { color: #6e7d96; }
    .slotEditor { width: 100%; min-height: 92px; resize: vertical; border: 1px solid var(--line); border-radius: 6px; background: #0c121c; color: #dce8ff; padding: 8px; font-family: "JetBrains Mono", "SFMono-Regular", Menlo, monospace; font-size: 12px; }
    .cardActions { display: flex; gap: 6px; }
    @media (max-width: 1100px) {
      #app { flex-direction: column; }
      #panel { width: 100%; min-width: 0; height: 58vh; }
      #stage { height: 42vh; min-height: 280px; }
    }
  `
  document.head.appendChild(style)

  const app = document.createElement('div')
  app.id = 'app'

  const stage = document.createElement('div')
  stage.id = 'stage'
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(640, Math.floor(window.innerWidth * 0.52))
  canvas.height = Math.max(360, Math.floor(window.innerHeight * 0.7))
  stage.appendChild(canvas)

  const panel = document.createElement('div')
  panel.id = 'panel'
  panel.innerHTML = `
    <div id="toolbar">
      <div id="toolbarRow">
        <button id="hitBtn" class="btn main">GLOBAL HIT (Space)</button>
        <button id="runAllBtn" class="btn">Run Current</button>
        <button id="audioBtn" class="btn">Start Audio</button>
        <button id="openOutBtn" class="btn">Open Output</button>
        <button id="fsOutBtn" class="btn">Fullscreen Output</button>
        <button id="closeOutBtn" class="btn">Close Output</button>
        <button id="resetBtn" class="btn warn">Reset Preset</button>
      </div>
      <div id="status">Ready</div>
    </div>
    <div id="sliders"></div>
    <div id="moocList"></div>
  `

  app.appendChild(stage)
  app.appendChild(panel)
  document.body.appendChild(app)

  return {
    canvas,
    statusEl: panel.querySelector('#status'),
    hitBtn: panel.querySelector('#hitBtn'),
    runAllBtn: panel.querySelector('#runAllBtn'),
    audioBtn: panel.querySelector('#audioBtn'),
    openOutBtn: panel.querySelector('#openOutBtn'),
    fsOutBtn: panel.querySelector('#fsOutBtn'),
    closeOutBtn: panel.querySelector('#closeOutBtn'),
    resetBtn: panel.querySelector('#resetBtn'),
    slidersEl: panel.querySelector('#sliders'),
    moocListEl: panel.querySelector('#moocList')
  }
}

function init () {
  const ui = initLayout()
  const state = loadState()
  const sliderInputs = []
  const sliderValueEls = []
  const editorEls = []
  const padBtnEls = []
  const playheadEls = []
  const armEls = []
  let outputWindow = null
  let outputVideo = null
  let outputStream = null
  let hydra = null

  try {
    hydra = new Hydra({ detectAudio: true, makeGlobal: true, canvas: ui.canvas })
  } catch (error) {
    ui.statusEl.textContent = `Hydra failed to initialize: ${error.message}`
    ui.statusEl.style.color = 'var(--danger)'
    console.error(error)
    return
  }

  function setStatus (message, isError = false) {
    ui.statusEl.textContent = message
    ui.statusEl.style.color = isError ? 'var(--danger)' : 'var(--muted)'
  }

  function persist () {
    saveState(state)
  }

  function sanitizeState () {
    for (let m = 0; m < NUM_MOOCS; m += 1) {
      if (!Array.isArray(state.bins[m])) state.bins[m] = new Array(SLOTS_PER_MOOC).fill('')
      for (let s = 0; s < SLOTS_PER_MOOC; s += 1) {
        if (typeof state.bins[m][s] !== 'string') state.bins[m][s] = ''
      }
      state.playheads[m] = Number.isInteger(state.playheads[m]) ? ((state.playheads[m] % SLOTS_PER_MOOC) + SLOTS_PER_MOOC) % SLOTS_PER_MOOC : 0
      state.selectedSlots[m] = Number.isInteger(state.selectedSlots[m]) ? ((state.selectedSlots[m] % SLOTS_PER_MOOC) + SLOTS_PER_MOOC) % SLOTS_PER_MOOC : 0
      state.armed[m] = state.armed[m] !== false
    }
    for (let i = 0; i < NUM_SLIDERS; i += 1) {
      state.sliders[i] = clamp01(Number(state.sliders[i]) || 0)
    }
  }

  function updatePadClasses (moocIndex) {
    const selected = state.selectedSlots[moocIndex]
    const playhead = state.playheads[moocIndex]
    for (let s = 0; s < SLOTS_PER_MOOC; s += 1) {
      const btn = padBtnEls[moocIndex][s]
      const code = state.bins[moocIndex][s]
      btn.classList.toggle('selected', selected === s)
      btn.classList.toggle('playhead', playhead === s)
      btn.classList.toggle('empty', !code.trim())
    }
    playheadEls[moocIndex].textContent = `Playhead: ${playhead + 1}`
    editorEls[moocIndex].value = state.bins[moocIndex][selected]
  }

  function updateAllPads () {
    for (let m = 0; m < NUM_MOOCS; m += 1) updatePadClasses(m)
  }

  function runCode (code, meta) {
    if (!code || !code.trim()) return false
    try {
      const fn = new Function('meta', `
        const p = (index) => window.params[index - 1] || 0
        const s = p
        ${code}
      `)
      fn(meta)
      return true
    } catch (error) {
      setStatus(`Error @ M${meta.mooc + 1}/S${meta.slot + 1}: ${error.message}`, true)
      console.error(error)
      return false
    }
  }

  function startAudio () {
    if (!window.a) {
      setStatus('Audio analyzer not ready yet. Click again after mic permission.', true)
      return
    }
    if (window.a.context && window.a.context.state === 'suspended') {
      window.a.context.resume()
    }
    if (typeof window.a.show === 'function') window.a.show()
    setStatus('Audio started. If needed, allow mic access in browser permissions.')
  }

  function setupOutputWindow (win) {
    if (!win || win.closed) return false
    win.document.title = 'Hydra Output'
    win.document.body.style.margin = '0'
    win.document.body.style.background = '#000'
    win.document.body.style.overflow = 'hidden'
    win.document.body.innerHTML = `
      <video id="hydraOutputVideo" autoplay muted playsinline style="width:100vw;height:100vh;object-fit:contain;background:#000;display:block;"></video>
      <button id="hydraFsBtn" style="position:fixed;right:10px;bottom:10px;padding:8px 10px;border:1px solid #444;background:#111;color:#fff;border-radius:8px;cursor:pointer;opacity:0.75;">Fullscreen</button>
    `
    outputVideo = win.document.getElementById('hydraOutputVideo')
    outputVideo.autoplay = true
    outputVideo.muted = true
    outputVideo.playsInline = true
    const fsBtn = win.document.getElementById('hydraFsBtn')
    fsBtn.addEventListener('click', () => {
      if (outputVideo && outputVideo.requestFullscreen) {
        outputVideo.requestFullscreen().catch(() => {
          setStatus('Fullscreen blocked. Click inside output window and try again.', true)
        })
      }
    })
    win.addEventListener('beforeunload', () => {
      outputWindow = null
      outputVideo = null
      if (outputStream) {
        outputStream.getTracks().forEach((t) => t.stop())
        outputStream = null
      }
    })

    if (!ui.canvas.captureStream) {
      setStatus('captureStream not supported in this browser.', true)
      return false
    }

    if (outputStream) {
      outputStream.getTracks().forEach((t) => t.stop())
      outputStream = null
    }
    outputStream = ui.canvas.captureStream(30)
    outputVideo.srcObject = outputStream
    outputVideo.onloadedmetadata = () => {
      outputVideo.play().catch(() => {
        setStatus('Output opened. Click inside output window to start playback.', true)
      })
    }
    outputWindow = win
    return true
  }

  function openOutputWindow () {
    if (outputWindow && !outputWindow.closed) {
      outputWindow.focus()
      setStatus('Output window focused.')
      return
    }
    const win = window.open('', 'hydra-output-window', 'width=1280,height=720,left=40,top=40')
    if (!win) {
      setStatus('Popup blocked. Allow popups for this site.', true)
      return
    }
    const ok = setupOutputWindow(win)
    if (ok) {
      setStatus('Output window opened. Use Fullscreen Output for projector mode.')
    }
  }

  function fullscreenOutputWindow () {
    if (!outputWindow || outputWindow.closed || !outputVideo) {
      openOutputWindow()
    }
    if (outputVideo && outputVideo.requestFullscreen) {
      outputWindow.focus()
      outputVideo.requestFullscreen().then(() => {
        setStatus('Requested fullscreen on output window.')
      }).catch(() => {
        setStatus('Fullscreen blocked. Use the Fullscreen button in output window.', true)
      })
    }
  }

  function closeOutputWindow () {
    if (outputWindow && !outputWindow.closed) {
      outputWindow.close()
    }
    outputWindow = null
    outputVideo = null
    if (outputStream) {
      outputStream.getTracks().forEach((t) => t.stop())
      outputStream = null
    }
    setStatus('Output window closed.')
  }

  function hit (advancePlayheads) {
    let fired = 0
    for (let m = 0; m < NUM_MOOCS; m += 1) {
      if (!state.armed[m]) continue
      const slot = state.playheads[m]
      const code = state.bins[m][slot]
      const didRun = runCode(code, { mooc: m, slot, hit: true })
      if (didRun) fired += 1
      if (advancePlayheads) state.playheads[m] = (slot + 1) % SLOTS_PER_MOOC
    }
    updateAllPads()
    persist()
    setStatus(`Triggered ${fired} slots (${advancePlayheads ? 'advanced' : 'held'} playheads)`)
  }

  function runCurrentWithoutAdvance () {
    hit(false)
  }

  function runSelected (moocIndex) {
    const slot = state.selectedSlots[moocIndex]
    const code = state.bins[moocIndex][slot]
    const ok = runCode(code, { mooc: moocIndex, slot, hit: false })
    if (ok) setStatus(`Ran M${moocIndex + 1} / S${slot + 1}`)
  }

  function resetPreset () {
    const next = buildInitialState()
    state.bins = next.bins
    state.playheads = next.playheads
    state.armed = next.armed
    state.selectedSlots = next.selectedSlots
    state.sliders = next.sliders

    for (let i = 0; i < NUM_SLIDERS; i += 1) {
      sliderInputs[i].value = state.sliders[i]
      sliderValueEls[i].textContent = state.sliders[i].toFixed(3)
    }
    for (let m = 0; m < NUM_MOOCS; m += 1) {
      armEls[m].checked = state.armed[m]
      updatePadClasses(m)
    }
    persist()
    setStatus('Preset reset')
  }

  sanitizeState()
  window.params = state.sliders
  window.launcher = {
    hit: () => hit(true),
    runCurrent: () => runCurrentWithoutAdvance(),
    state,
    hydra
  }
  window.hydra = hydra

  for (let i = 0; i < NUM_SLIDERS; i += 1) {
    const row = document.createElement('div')
    row.className = 'sliderRow'
    row.innerHTML = `<div>P${i + 1}</div><input type="range" min="0" max="1" step="0.001"><div class="sliderValue"></div>`
    const input = row.querySelector('input')
    const valueEl = row.querySelector('.sliderValue')
    input.value = state.sliders[i]
    valueEl.textContent = state.sliders[i].toFixed(3)
    input.addEventListener('input', () => {
      state.sliders[i] = clamp01(Number(input.value) || 0)
      valueEl.textContent = state.sliders[i].toFixed(3)
      persist()
    })
    sliderInputs.push(input)
    sliderValueEls.push(valueEl)
    ui.slidersEl.appendChild(row)
  }

  for (let m = 0; m < NUM_MOOCS; m += 1) {
    padBtnEls[m] = []
    const card = document.createElement('div')
    card.className = 'moocCard'

    const top = document.createElement('div')
    top.className = 'moocTop'
    top.innerHTML = `
      <div class="moocTitle">
        <label><input type="checkbox"> Arm</label>
        <span>MOOC ${m + 1}</span>
      </div>
      <div class="playhead"></div>
    `
    const armInput = top.querySelector('input')
    armInput.checked = state.armed[m]
    armInput.addEventListener('change', () => {
      state.armed[m] = armInput.checked
      persist()
      setStatus(`MOOC ${m + 1} ${state.armed[m] ? 'armed' : 'muted'}`)
    })
    armEls[m] = armInput
    playheadEls[m] = top.querySelector('.playhead')
    card.appendChild(top)

    const grid = document.createElement('div')
    grid.className = 'padGrid'
    for (let s = 0; s < SLOTS_PER_MOOC; s += 1) {
      const btn = document.createElement('button')
      btn.className = 'pad'
      btn.textContent = `S${s + 1}`
      btn.addEventListener('click', () => {
        state.selectedSlots[m] = s
        state.playheads[m] = s
        updatePadClasses(m)
        persist()
      })
      padBtnEls[m][s] = btn
      grid.appendChild(btn)
    }
    card.appendChild(grid)

    const editor = document.createElement('textarea')
    editor.className = 'slotEditor'
    editor.placeholder = `Hydra code for MOOC ${m + 1}`
    editor.addEventListener('input', () => {
      const selected = state.selectedSlots[m]
      state.bins[m][selected] = editor.value
      updatePadClasses(m)
      persist()
    })
    editorEls[m] = editor
    card.appendChild(editor)

    const actions = document.createElement('div')
    actions.className = 'cardActions'
    const runBtn = document.createElement('button')
    runBtn.className = 'btn'
    runBtn.textContent = 'Run Selected'
    runBtn.addEventListener('click', () => runSelected(m))

    const clearBtn = document.createElement('button')
    clearBtn.className = 'btn'
    clearBtn.textContent = 'Clear Selected'
    clearBtn.addEventListener('click', () => {
      const selected = state.selectedSlots[m]
      state.bins[m][selected] = ''
      updatePadClasses(m)
      persist()
      setStatus(`Cleared M${m + 1} / S${selected + 1}`)
    })

    actions.appendChild(runBtn)
    actions.appendChild(clearBtn)
    card.appendChild(actions)

    ui.moocListEl.appendChild(card)
    updatePadClasses(m)
  }

  ui.hitBtn.addEventListener('click', () => hit(true))
  ui.runAllBtn.addEventListener('click', runCurrentWithoutAdvance)
  ui.audioBtn.addEventListener('click', startAudio)
  ui.openOutBtn.addEventListener('click', openOutputWindow)
  ui.fsOutBtn.addEventListener('click', fullscreenOutputWindow)
  ui.closeOutBtn.addEventListener('click', closeOutputWindow)
  ui.resetBtn.addEventListener('click', resetPreset)

  window.addEventListener('keydown', (event) => {
    const tag = (event.target && event.target.tagName) ? event.target.tagName.toLowerCase() : ''
    if (tag === 'textarea' || tag === 'input') return
    if (event.code === 'Space') {
      event.preventDefault()
      hit(true)
    }
  })

  window.addEventListener('resize', () => {
    ui.canvas.width = Math.max(640, Math.floor(ui.canvas.clientWidth))
    ui.canvas.height = Math.max(360, Math.floor(ui.canvas.clientHeight))
    if (typeof setResolution === 'function') {
      setResolution(ui.canvas.width, ui.canvas.height)
    }
  })
  window.addEventListener('beforeunload', closeOutputWindow)

  solid(0, 0, 0, 1).out()
  setStatus('Hydra launcher ready. Click Start Audio, then use P1-P5 via p(1)..p(5).')
}

window.onload = init
