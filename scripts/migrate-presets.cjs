#!/usr/bin/env node
// migrate-presets.js — One-time migration: .md presets → .json, extract hardcoded Scope/CA presets
// Run from project root: node scripts/migrate-presets.js

const fs = require('fs')
const path = require('path')

const PRESETS_DIR = path.join(__dirname, '..', 'presets')
const ARCHIVE_DIR = path.join(PRESETS_DIR, '_archive', 'md-backup')

// ---- Helpers ----
function parsePresetMarkdown (source) {
  const fenced = source.match(/```(?:js|javascript|hydra)?\s*([\s\S]*?)```/m)
  return fenced && fenced[1] ? fenced[1].trim() : source.trim()
}

function parsePresetFilters (source) {
  var match = source.match(/<!-- filters:(.*?) -->/)
  if (match) {
    try { return JSON.parse(match[1]) } catch (e) {}
  }
  return null
}

function detectTags (code) {
  var tags = []
  if (/src\(s3\)|scope\.|scope\[/.test(code)) tags.push('scope')
  if (/caStream\(/.test(code)) tags.push('ca')
  return tags
}

// ---- Step 1: Read index.json for descriptions ----
var mdIndex = {}
try {
  var idx = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, 'index.json'), 'utf8'))
  idx.forEach(function (e) { mdIndex[e.file] = e })
} catch (e) {
  console.log('Warning: could not read index.json —', e.message)
}

// ---- Step 2: Convert .md presets to .json ----
var mdFiles = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'))
console.log(`Found ${mdFiles.length} .md presets to convert`)

var converted = 0
mdFiles.forEach(function (mdFile) {
  var mdPath = path.join(PRESETS_DIR, mdFile)
  var content = fs.readFileSync(mdPath, 'utf8')

  var code = parsePresetMarkdown(content)
  var filters = parsePresetFilters(content)
  var tags = detectTags(code)

  // Get name/description from index or filename
  var entry = mdIndex[mdFile] || {}
  var baseName = mdFile.replace(/\.md$/, '')
  var name = entry.name || baseName
  var description = entry.description || ''

  var jsonFile = baseName + '.json'
  var jsonPath = path.join(PRESETS_DIR, jsonFile)

  // Don't overwrite if .json already exists
  if (fs.existsSync(jsonPath)) {
    console.log(`  SKIP ${mdFile} → ${jsonFile} (already exists)`)
    return
  }

  var preset = {
    name: name,
    description: description,
    tags: tags,
    code: code
  }
  if (filters) preset.filters = filters

  fs.writeFileSync(jsonPath, JSON.stringify(preset, null, 2) + '\n')
  console.log(`  OK   ${mdFile} → ${jsonFile}` + (tags.length ? ` [${tags.join(', ')}]` : ''))
  converted++
})

console.log(`\nConverted ${converted} presets`)

// ---- Step 3: Create Scope presets from previously hardcoded data ----
var scopePresets = [
  {
    name: 'Clean Feed',
    file: 'scope-clean-feed.json',
    description: 'Pure AI feed, no hydra processing',
    tags: ['scope'],
    code: '// Daydream Clean Feed — pure AI feed, no hydra processing\n// s3 = Scope NDI (auto-initialized)\n\nsrc(s3)\n  .out(o0);'
  },
  {
    name: 'Scope 01',
    file: 'scope-01.json',
    description: 'AI feed layered with hydra organic texture',
    tags: ['scope'],
    code: "// Daydream Blend — AI feed layered with hydra organic texture\n// s3 = Scope NDI (auto-initialized)\n\nAUDIO.bins = 6; AUDIO.smooth = 0.92; AUDIO.apply();\nvar _lo = function(){ return a.fft[0] || 0 };\nvar _mi = function(){ return a.fft[2] || 0 };\nvar low  = env(_lo, 0.4, 0.04);\nvar mid  = env(_mi, 0.45, 0.05);\nvar amp  = function(){ return (low() + mid()) * 0.5 };\n\nsrc(s3)\n  .saturate(1.2)\n  .out(o1);\n\nnoise(2.5, 0.04)\n  .rotate(() => time * 0.02)\n  .modulate(noise(1.2, 0.03), 0.12)\n  .color(0.85, 0.5, 0.3)\n  .brightness(-0.25)\n  .out(o2);\n\nsrc(o1)\n  .blend(src(o2), 0.25)\n  .out(o3);\n\nsrc(o0)\n  .blend(src(o3), 0.1)\n  .modulateScale(noise(1.4, 0.02), () => 0.005 + amp() * 0.0005)\n  .modulateRotate(noise(0.3, 0.015), 0.003)\n  .hue(() => 0.015 * Math.sin(time * 0.02) + 0.004 * low())\n  .luma(0.01, 0.06)\n  .saturate(() => 1.35 + amp() * 0.025)\n  .contrast(1.02)\n  .out(o0);"
  },
  {
    name: 'Scope 02',
    file: 'scope-02.json',
    description: 'Smoke Mirror — AI feed diffused through deep feedback fog',
    tags: ['scope'],
    code: "// Smoke Mirror — AI feed diffused through deep feedback fog\n// s3 = Scope NDI (auto-initialized)\n\nAUDIO.bins = 4; AUDIO.smooth = 0.94; AUDIO.apply();\nvar _lo = function(){ return a.fft[0] || 0 };\nvar _mi = function(){ return a.fft[2] || 0 };\nvar low = env(_lo, 0.5, 0.03);\nvar mid = env(_mi, 0.4, 0.05);\n\n// AI feed — soft, desaturated\nsrc(s3)\n  .saturate(0.7)\n  .brightness(-0.05)\n  .out(o1);\n\n// feedback accumulator — very long decay\nsrc(o0)\n  .scale(1.002)\n  .rotate(function(){ return 0.0008 + low() * 0.0002 })\n  .saturate(0.97)\n  .brightness(-0.003)\n  .out(o2);\n\n// composite: seed AI into feedback fog\nsrc(o2)\n  .blend(src(o1), 0.12)\n  .modulate(noise(1.5, 0.015), function(){ return 0.008 + mid() * 0.003 })\n  .hue(function(){ return 0.006 * Math.sin(time * 0.015) })\n  .luma(0.008, 0.04)\n  .contrast(1.015)\n  .out(o0);"
  }
]

// Note: Scope 03/04/05 are already covered by 051/052/053 .md files which get auto-tagged ["scope"]

var scopeCreated = 0
scopePresets.forEach(function (sp) {
  var jsonPath = path.join(PRESETS_DIR, sp.file)
  if (fs.existsSync(jsonPath)) {
    console.log(`  SKIP ${sp.file} (already exists)`)
    return
  }
  var preset = { name: sp.name, description: sp.description, tags: sp.tags, code: sp.code }
  fs.writeFileSync(jsonPath, JSON.stringify(preset, null, 2) + '\n')
  console.log(`  OK   ${sp.file} [scope]`)
  scopeCreated++
})
console.log(`Created ${scopeCreated} Scope presets`)

// ---- Step 4: Create CA presets from previously hardcoded data ----
var caPresets = [
  { name: 'Gliders', file: 'ca-gliders.json', description: 'Caustics + CA — caustic shader with SL gliders' },
  { name: 'Tide Pool', file: 'ca-tide-pool.json', description: 'Caustics — denser, slower, offset palette with CA ripples' },
  { name: 'Amoeba', file: 'ca-amoeba.json', description: 'Caustics — wide scale, organic speed, CA creatures warp light' },
  { name: 'Lenia', file: 'ca-lenia.json', description: 'Warm osc field — CA blobs modulate oscillator math' },
  { name: 'SL Worms', file: 'ca-sl-worms.json', description: 'Noise feedback — CA worms tunnel through texture' },
  { name: 'MNCA', file: 'ca-mnca.json', description: 'Voronoi + osc — CA solitons warp both coordinate systems' },
  { name: 'MNCA 2', file: 'ca-mnca-2.json', description: 'Deep feedback — CA mitosis drives the accumulator' },
  { name: 'CA Flock', file: 'ca-flock.json', description: 'Flock shapes — CA vortex distorts their coordinates' },
  { name: 'CA Warp', file: 'ca-warp.json', description: 'Deep warp — CA organisms bend space itself' }
]

// Extract CA code from the git history (the IIFEs we just removed)
// We need to get these from the previous commit
console.log('\nCA presets need to be extracted from git history...')
var caExtracted = 0

// Try reading from git show of the file before our changes
var { execSync } = require('child_process')
try {
  var oldHtml = execSync('git show HEAD:dist/launcher.html', { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })

  // Extract the caPresets array from the old HTML
  var caMatch = oldHtml.match(/var caPresets = \[([\s\S]*?)\n\s*\]\s*\n\s*var container = document\.getElementById\('caPresets'\)/)
  if (caMatch) {
    // Parse individual preset objects using a regex for { name: '...', code: "..." }
    var presetPattern = /\{\s*name:\s*'([^']+)',\s*\n\s*code:\s*"((?:[^"\\]|\\.)*)"\s*\}/g
    var match
    var caCodeMap = {}
    while ((match = presetPattern.exec(caMatch[1])) !== null) {
      // Unescape the JS string
      var code = match[2]
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
      caCodeMap[match[1]] = code
    }

    caPresets.forEach(function (ca) {
      var jsonPath = path.join(PRESETS_DIR, ca.file)
      if (fs.existsSync(jsonPath)) {
        console.log(`  SKIP ${ca.file} (already exists)`)
        return
      }
      var code = caCodeMap[ca.name]
      if (!code) {
        console.log(`  WARN ${ca.file} — code not found for "${ca.name}"`)
        return
      }
      var preset = { name: ca.name, description: ca.description, tags: ['ca'], code: code }
      fs.writeFileSync(jsonPath, JSON.stringify(preset, null, 2) + '\n')
      console.log(`  OK   ${ca.file} [ca]`)
      caExtracted++
    })
  } else {
    console.log('  ERROR: could not find caPresets array in git history')
  }
} catch (e) {
  console.log('  ERROR extracting from git:', e.message)
}
console.log(`Created ${caExtracted} CA presets`)

// ---- Step 5: Archive .md files ----
console.log('\nArchiving .md files...')
fs.mkdirSync(ARCHIVE_DIR, { recursive: true })

var archived = 0
mdFiles.forEach(function (mdFile) {
  var jsonFile = mdFile.replace(/\.md$/, '.json')
  // Only archive if the .json version exists
  if (fs.existsSync(path.join(PRESETS_DIR, jsonFile))) {
    var src = path.join(PRESETS_DIR, mdFile)
    var dst = path.join(ARCHIVE_DIR, mdFile)
    fs.renameSync(src, dst)
    console.log(`  ${mdFile} → _archive/md-backup/${mdFile}`)
    archived++
  }
})
console.log(`Archived ${archived} .md files`)

// ---- Step 6: Archive index.json ----
var indexPath = path.join(PRESETS_DIR, 'index.json')
if (fs.existsSync(indexPath)) {
  fs.renameSync(indexPath, path.join(PRESETS_DIR, '_archive', 'index.json.bak'))
  console.log('Archived index.json → _archive/index.json.bak')
}

// ---- Summary ----
var jsonFiles = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'))
console.log(`\n=== Done ===`)
console.log(`${jsonFiles.length} .json presets in ${PRESETS_DIR}`)
console.log(`${archived} .md files archived`)
console.log('\nRestart server and hard-refresh to verify.')
