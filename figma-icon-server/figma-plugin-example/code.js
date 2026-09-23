// code.js (Figma 플러그인 메인 스레드) — Sticker generator
// PNG 모드: UI가 만든 투명 PNG를 이미지 fill로 배치
// Vector 모드: UI가 만든 SVG를 figma.createNodeFromSvg로 넣어서 편집 가능한 레이어로 배치
//   레이어: Border(흰 칼선) / Base / Colors(색마다 하나) / Outline(stroke)

const TOOL_ID = 'run'
const DISPLAY_NAME = 'Sticker generator'
const PARAMS_KEY = TOOL_ID + ':params'
const UI_WIDTH = 300

const DEFAULTS = { subject: '', extraDetail: '', stickerSize: 160, colors: [], outlineColor: '#252C46' }

let last = null // { imageHash | svg, layerNames, subject, extraDetail, stickerSize, colors, outlineColor, outlinePct, mode, singleOnly }

function safeParseParams(s) {
  try {
    const obj = JSON.parse(s)
    if (typeof obj?.subject !== 'string') return null
    const size = obj.stickerSize
    if (typeof size !== 'number' || size < 32 || size > 512) return null
    return {
      subject: obj.subject,
      extraDetail: typeof obj.extraDetail === 'string' ? obj.extraDetail : '',
      stickerSize: size,
      colors: Array.isArray(obj.colors)
        ? obj.colors.filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 4)
        : [],
      outlineColor:
        typeof obj.outlineColor === 'string' && /^#[0-9a-f]{6}$/i.test(obj.outlineColor)
          ? obj.outlineColor
          : DEFAULTS.outlineColor,
    }
  } catch {
    return null
  }
}

function paramsOf(p) {
  const { subject, extraDetail, stickerSize, colors, outlineColor, outlinePct, mode, singleOnly, simplify } = p
  return { subject, extraDetail, stickerSize, colors, outlineColor, outlinePct, mode, singleOnly, simplify }
}

function position(node, size, index, total) {
  const gap = 16
  const center = figma.viewport.center
  const totalWidth = total * size + (total - 1) * gap
  node.x = Math.round(center.x - totalWidth / 2 + index * (size + gap))
  node.y = Math.round(center.y - size / 2)
}

function tag(node, p) {
  node.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
  node.setPluginData(PARAMS_KEY, JSON.stringify(paramsOf(p)))
}

function placeRaster(p, index, total) {
  const size = p.stickerSize
  const frame = figma.createFrame()
  frame.name = 'Sticker / ' + p.subject
  frame.resize(size, size)
  frame.clipsContent = false
  frame.fills = [{ type: 'IMAGE', imageHash: p.imageHash, scaleMode: 'FIT' }]
  position(frame, size, index, total)
  tag(frame, p)
  return frame
}

function placeVector(p, index, total) {
  const size = p.stickerSize
  const frame = figma.createNodeFromSvg(p.svg)
  frame.name = 'Sticker / ' + p.subject
  frame.fills = []
  frame.clipsContent = false

  // SVG를 그린 순서 = 벡터 노드 순서 → UI가 보낸 이름을 순서대로 붙임
  const names = p.layerNames || []
  const vectors = frame.findAll((n) => n.type === 'VECTOR')
  vectors.forEach((v, i) => { if (names[i]) v.name = names[i] })
  vectors.forEach((v) => {
    if (/^(Color |#)/.test(v.name) && v.parent && v.parent.type === 'GROUP') v.parent.name = 'Colors'
  })
  frame.rescale(size / frame.width) // stroke 두께까지 같이 스케일
  position(frame, size, index, total)
  tag(frame, p)
  return frame
}

function place(p, index, total) {
  return p.mode === 'vector' ? placeVector(p, index, total) : placeRaster(p, index, total)
}

const sel = figma.currentPage.selection
const stored = sel.length === 1 ? safeParseParams(sel[0].getPluginData(PARAMS_KEY)) : null

figma.root.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
figma.showUI(__html__, { width: UI_WIDTH, height: 560, themeColors: true })

if (stored) {
  figma.ui.postMessage({ type: 'params-change', params: stored })
}

const placedThisRun = []

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'resize') {
    figma.ui.resize(UI_WIDTH, Math.max(200, Math.min(900, Math.round(msg.height))))
    return
  }

  if (msg.type === 'notify') {
    figma.notify(msg.message, { error: !!msg.error })
    return
  }

  if (msg.type === 'generate-start') {
    placedThisRun.length = 0
    return
  }

  if (msg.type === 'generate-done') {
    if (placedThisRun.length) {
      figma.viewport.scrollAndZoomIntoView(placedThisRun)
      figma.notify(
        '스티커 ' + placedThisRun.length + '개를 만들었어요' +
        (msg.failed ? ' (' + msg.failed + '개 실패)' : '')
      )
    }
    return
  }

  if (msg.type === 'place-again') {
    if (!last) {
      figma.notify('아직 생성한 스티커가 없어요', { error: true })
      return
    }
    const frame = place(last, 0, 1)
    figma.currentPage.selection = [frame]
    figma.viewport.scrollAndZoomIntoView([frame])
    figma.notify('스티커를 다시 배치했어요')
    return
  }

  if (msg.type === 'image-ready' || msg.type === 'vector-ready') {
    try {
      const p = {
        subject: msg.subject,
        extraDetail: msg.extraDetail || '',
        stickerSize: msg.stickerSize,
        colors: msg.colors || [],
        outlineColor: msg.outlineColor || DEFAULTS.outlineColor,
        outlinePct: msg.outlinePct || DEFAULTS.outlinePct,
        singleOnly: msg.singleOnly !== false,
        simplify: typeof msg.simplify === 'number' ? msg.simplify : DEFAULTS.simplify,
        mode: msg.type === 'vector-ready' ? 'vector' : 'png',
      }
      if (p.mode === 'vector') {
        p.svg = msg.svg
        p.layerNames = msg.layerNames || []
      } else {
        p.imageHash = figma.createImage(new Uint8Array(msg.bytes)).hash
      }
      last = p
      const frame = place(p, msg.index || 0, msg.total || 1)
      placedThisRun.push(frame)
      figma.currentPage.selection = placedThisRun.slice()
    } catch (error) {
      figma.notify(error instanceof Error ? error.message : String(error), { error: true })
    }
    figma.ui.postMessage({ type: 'generation-complete' })
  }
}
