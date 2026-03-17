import Meyda from 'meyda'

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
       // reduce loudness array to number of bins
       const reducer = (accumulator, currentValue) => accumulator + currentValue;
       let spacing = Math.floor(features.loudness.specific.length/this.bins.length)
       this.prevBins = this.bins.slice(0)
       this.bins = this.bins.map((bin, index) => {
         return features.loudness.specific.slice(index * spacing, (index + 1)*spacing).reduce(reducer)
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
    // to do: what to do in non-global mode?
    this.bins.forEach((bin, index) => {
      window['a' + index] = (scale = 1, offset = 0) => () => (a.fft[index] * scale + offset)
    })
  //  console.log(this.settings)
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
