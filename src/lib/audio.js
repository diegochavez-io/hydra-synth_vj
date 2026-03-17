import Meyda from 'meyda'

// Upper-edge frequencies for Meyda's 24 Bark bands (25 edges, 24 bands)
const BARK_EDGES = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500]

class Audio {
  constructor ({
    numBins = 4,
    cutoff = 2,
    smooth = 0.4,
    max = 15,
    scale = 10,
    isDrawing = false,
    parentEl = document.body
  }) {
    this.vol = 0
    this.scale = scale
    this.max = max
    this.cutoff = cutoff
    this.smooth = smooth
    this.setBins(numBins)

    // beat detection from: https://github.com/therewasaguy/p5-music-viz/blob/gh-pages/demos/01d_beat_detect_amplitude/sketch.js
    this.beat = {
      holdFrames: 20,
      threshold: 40,
      _cutoff: 0, // adaptive based on sound state
      decay: 0.98,
      _framesSinceBeat: 0 // keeps track of frames
    }

    this.onBeat = () => {
    //  console.log("beat")
    }

    // legacy canvas (hidden — replaced by meter panel in launcher)
    this.canvas = document.createElement('canvas')
    this.canvas.width = 100
    this.canvas.height = 80
    this.canvas.style.width = "100px"
    this.canvas.style.height = "80px"
    this.canvas.style.position = 'absolute'
    this.canvas.style.right = '0px'
    this.canvas.style.bottom = '0px'
    this.canvas.style.display = 'none'
    parentEl.appendChild(this.canvas)

    this.isDrawing = false
    this.ctx = this.canvas.getContext('2d')
    this.ctx.fillStyle="#DFFFFF"
    this.ctx.strokeStyle="#0ff"
    this.ctx.lineWidth=0.5

    // detailed FFT for meter panel
    this.analyser = null
    this.frequencyData = null
    this.lufs = -60
    this.gainNode = null
    this.inputGain = 1.0
    this._sourceNode = null

    if(window.navigator.mediaDevices) {
    window.navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })
      .then((stream) => {
        this.stream = stream
        this.context = new AudioContext()
        this._sourceNode = this.context.createMediaStreamSource(stream)

        // gain node for input boost
        this.gainNode = this.context.createGain()
        this.gainNode.gain.value = this.inputGain
        this._sourceNode.connect(this.gainNode)

        // AnalyserNode for detailed spectrum
        this.analyser = this.context.createAnalyser()
        this.analyser.fftSize = 2048
        this.analyser.smoothingTimeConstant = 0.8
        this.analyser.minDecibels = -90
        this.analyser.maxDecibels = -10
        this.gainNode.connect(this.analyser)
        this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount)

        this.meyda = Meyda.createMeydaAnalyzer({
          audioContext: this.context,
          source: this.gainNode,
          featureExtractors: [
            'loudness',
          ]
        })
      })
      .catch((err) => console.log('ERROR', err))
    }
  }

  detectBeat (level) {
    //console.log(level,   this.beat._cutoff)
    if (level > this.beat._cutoff && level > this.beat.threshold) {
      this.onBeat()
      this.beat._cutoff = level *1.2
      this.beat._framesSinceBeat = 0
    } else {
      if (this.beat._framesSinceBeat <= this.beat.holdFrames){
        this.beat._framesSinceBeat ++;
      } else {
        this.beat._cutoff *= this.beat.decay
        this.beat._cutoff = Math.max(  this.beat._cutoff, this.beat.threshold);
      }
    }
  }

  tick() {
   // update detailed FFT for meter panel
   if (this.analyser) {
     this.analyser.getByteFrequencyData(this.frequencyData)
   }

   if(this.meyda){
     var features = this.meyda.get()
     if(features && features !== null){
       this.vol = features.loudness.total
       // approximate loudness in dB (smoothed)
       var rawLufs = this.vol > 0 ? 20 * Math.log10(this.vol / 24) - 14 : -60
       this.lufs = this.lufs * 0.9 + rawLufs * 0.1
       this.detectBeat(this.vol)
       // reduce loudness Bark bands to bins using frequency boundaries
       var loudBands = features.loudness.specific
       var numBands = loudBands.length // 24
       var boundaries = this.binBoundaries || []
       // build full boundary list: [20, ...boundaries, 15500]
       var edges = [20].concat(boundaries).concat([15500])
       this.prevBins = this.bins.slice(0)
       this.bins = this.bins.map((bin, bi) => {
         var binLo = edges[bi]
         var binHi = edges[bi + 1]
         var sum = 0
         for (var band = 0; band < numBands; band++) {
           var bandLo = BARK_EDGES[band]
           var bandHi = BARK_EDGES[band + 1]
           // compute overlap
           var overlapLo = Math.max(binLo, bandLo)
           var overlapHi = Math.min(binHi, bandHi)
           if (overlapHi <= overlapLo) continue
           var bandWidth = bandHi - bandLo
           var fraction = bandWidth > 0 ? (overlapHi - overlapLo) / bandWidth : 0
           sum += loudBands[band] * fraction
         }
         return sum
       }).map((bin, index) => {
          return (bin * (1.0 - this.settings[index].smooth) + this.prevBins[index] * this.settings[index].smooth)
       })
       this.fft = this.bins.map((bin, index) => (
         Math.max(0, (bin - this.settings[index].cutoff)/this.settings[index].scale)
       ))
       if(this.isDrawing) this.draw()
     }
   }
  }

  setCutoff (cutoff) {
    this.cutoff = cutoff
    this.settings = this.settings.map((el) => {
      el.cutoff = cutoff
      return el
    })
  }

  setSmooth (smooth) {
    this.smooth = smooth
    this.settings = this.settings.map((el) => {
      el.smooth = smooth
      return el
    })
  }

  setBins (numBins) {
    this.bins = Array(numBins).fill(0)
    this.prevBins = Array(numBins).fill(0)
    this.fft = Array(numBins).fill(0)
    this.settings = Array(numBins).fill(0).map(() => ({
      cutoff: this.cutoff,
      scale: this.scale,
      smooth: this.smooth
    }))
    // generate default log-spaced bin boundaries
    this._generateDefaultBoundaries(numBins)
    // to do: what to do in non-global mode?
    this.bins.forEach((bin, index) => {
      window['a' + index] = (scale = 1, offset = 0) => () => (a.fft[index] * scale + offset)
    })
  }

  _generateDefaultBoundaries (numBins) {
    // log-spaced splits across 20–15500 Hz
    var lo = Math.log10(20)
    var hi = Math.log10(15500)
    this.binBoundaries = []
    for (var i = 1; i < numBins; i++) {
      this.binBoundaries.push(Math.round(Math.pow(10, lo + (hi - lo) * i / numBins)))
    }
    // curated defaults for 4 bins
    if (numBins === 4) this.binBoundaries = [150, 500, 2000]
  }

  setBinBoundaries (boundaries) {
    if (!Array.isArray(boundaries)) return
    // validate: must be sorted ascending, within 20–15500, length = numBins - 1
    var sorted = boundaries.slice().sort((a, b) => a - b)
    var valid = sorted.length === this.bins.length - 1 &&
      sorted.every((f, i) => f >= 20 && f <= 15500 && (i === 0 || f > sorted[i - 1]))
    if (valid) {
      this.binBoundaries = sorted
    }
  }

  setScale(scale){
    this.scale = scale
    this.settings = this.settings.map((el) => {
      el.scale = scale
      return el
    })
  }

  setMax(max) {
    this.max = max
    console.log('set max is deprecated')
  }

  setGain (value) {
    this.inputGain = value
    if (this.gainNode) {
      this.gainNode.gain.value = value
    }
  }

  switchInput (deviceId) {
    if (!this.context) return Promise.reject(new Error('No audio context'))
    return window.navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    }).then((stream) => {
      // disconnect old source
      if (this._sourceNode) {
        this._sourceNode.disconnect()
      }

      // stop old stream tracks
      if (this.stream) {
        this.stream.getTracks().forEach(t => t.stop())
      }

      // connect new source through gain node
      this.stream = stream
      this._sourceNode = this.context.createMediaStreamSource(stream)
      this._sourceNode.connect(this.gainNode)

      // recreate meyda (gain→analyser stays connected)
      this.meyda = Meyda.createMeydaAnalyzer({
        audioContext: this.context,
        source: this.gainNode,
        featureExtractors: ['loudness']
      })
    })
  }

  hide() {
    this.isDrawing = false
    this.canvas.style.display = 'none'
  }

  show() {
    this.isDrawing = false
    this.canvas.style.display = 'none'
  }

  draw () {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    var spacing = this.canvas.width / this.bins.length
    var scale = this.canvas.height / (this.max * 2)
    this.bins.forEach((bin, index) => {
      var height = bin * scale
     this.ctx.fillRect(index * spacing, this.canvas.height - height, spacing, height)
     var y = this.canvas.height - scale*this.settings[index].cutoff
     this.ctx.beginPath()
     this.ctx.moveTo(index*spacing, y)
     this.ctx.lineTo((index+1)*spacing, y)
     this.ctx.stroke()
     var yMax = this.canvas.height - scale*(this.settings[index].scale + this.settings[index].cutoff)
     this.ctx.beginPath()
     this.ctx.moveTo(index*spacing, yMax)
     this.ctx.lineTo((index+1)*spacing, yMax)
     this.ctx.stroke()
    })
  }
}

export default Audio
