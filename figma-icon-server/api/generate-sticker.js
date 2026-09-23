// api/generate-sticker.js  (v3)
//
// Figma 스티커 플러그인 → /api/generate-sticker → Gemini(나노바나나) → 이미지 반환
//
// 역할 분담
//   서버/모델: 외곽선·흰 테두리 없는 "플랫한 색 면" 일러스트 1개를 키 컬러 배경 위에 생성
//   플러그인:  배경 제거 → 주 객체만 남김 → 팔레트로 색 스냅 → 외곽선 + 흰 칼선 (PNG 또는 벡터)
//
// v3에서 바뀐 점
// 1) 객체 여러 개 문제
//    - 스타일 앵커를 "여러 개가 한 장에 있는 시트" → "한 장에 하나씩, 따로따로" 보냄.
//      (예전 앵커 한 장에 5개가 있어서 모델이 "여러 개 그리는 게 정답"으로 학습했던 게 주원인)
//    - 프롬프트에 단일 객체 조건 강화 + 1:1 비율 고정.
// 2) 명암이 제멋대로인 문제
//    - 고른 색마다 서버에서 [밝은 면 / 기본 / 그림자 면] 3단 램프를 계산해서 hex로 못 박음.
//    - "빛은 왼쪽 위 하나" 규칙과 면 방향 → 톤 대응을 명시.
//    - 색 순서에 역할 부여: 1번 = 메인(면적 대부분), 2번 = 보조, 3번~ = 포인트.
//    - 램프를 응답(palette)으로 돌려줘서, 플러그인이 모든 픽셀을 이 색들로 스냅함
//      → 팔레트 밖 색은 결과물에 절대 안 남음.

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const GEMINI_MODEL = "gemini-2.5-flash-image";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const MAX_COLORS = 6;

// ── 색상 유틸 ─────────────────────────────────────────────────────
const HEX_RE = /^#[0-9a-f]{6}$/i;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
}
function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// 한 색 → [기본, 그림자] 2톤
// (3톤이던 때 모델이 톤마다 면을 쪼개고 테두리 링·베벨까지 그려서 복잡해졌음 → 2톤으로 제한)
const SHADE_MUL = [0.8, 0.78, 0.87];

function makeRamp(hex) {
  const rgb = hexToRgb(hex);
  const shadow = rgb.map((v, i) => v * SHADE_MUL[i]);
  return { base: hex.toUpperCase(), shadow: rgbToHex(shadow) };
}

const NAMED_COLORS = [
  ["red", [220, 40, 40]], ["coral", [245, 110, 90]], ["orange", [245, 140, 30]],
  ["peach", [250, 190, 150]], ["mustard yellow", [210, 170, 40]], ["yellow", [250, 210, 40]],
  ["cream", [250, 240, 215]], ["beige", [230, 210, 170]], ["brown", [130, 80, 40]],
  ["olive green", [120, 130, 50]], ["lime green", [150, 210, 50]], ["green", [40, 160, 70]],
  ["mint", [160, 230, 200]], ["teal", [20, 150, 150]], ["sky blue", [90, 180, 240]],
  ["blue", [40, 90, 220]], ["navy", [25, 35, 90]], ["lavender", [190, 160, 230]],
  ["purple", [130, 60, 190]], ["pink", [245, 150, 190]], ["hot pink", [235, 50, 130]],
  ["burgundy", [120, 20, 40]], ["white", [255, 255, 255]], ["light gray", [200, 200, 200]],
  ["gray", [128, 128, 128]], ["charcoal", [55, 55, 60]], ["black", [15, 15, 15]],
];

function colorName(hex) {
  const rgb = hexToRgb(hex);
  let best = NAMED_COLORS[0];
  for (const c of NAMED_COLORS) if (dist(c[1], rgb) < dist(best[1], rgb)) best = c;
  return best[0];
}

// 배경(키 컬러) 후보 — 팔레트 램프 전체 + 흰색 + 어두운 색과 가장 먼 것
const KEY_CANDIDATES = [
  ["bright green", "#00FF00"],
  ["magenta", "#FF00FF"],
  ["cyan", "#00FFFF"],
  ["pure blue", "#0000FF"],
  ["chartreuse", "#80FF00"],
  ["orange-red", "#FF4000"],
];

// avoidHex: 재시도일 때 지난번 키 컬러 (모델이 그 색을 제대로 안 칠했으니 다른 색으로)
function pickKeyColor(paletteHexes, avoidHex) {
  const cands = KEY_CANDIDATES.filter((c) => !avoidHex || c[1].toLowerCase() !== String(avoidHex).toLowerCase());
  // 색을 안 골랐으면 모델이 색을 정하니까, 물체에 가장 드문 초록 크로마키를 기본으로
  // (예전엔 흰색·검정만 피해서 마젠타가 골라졌는데, 빨강·핑크 물체(홍등, 립스틱)와 겹쳤음)
  if (!paletteHexes.length) {
    const c = cands.find((k) => k[0] === "bright green") || cands[0];
    return { name: c[0], hex: c[1] };
  }
  const avoid = paletteHexes.map(hexToRgb).concat([[255, 255, 255], [30, 30, 40]]);
  let best = cands[0];
  let bestScore = -1;
  for (const cand of cands) {
    const rgb = hexToRgb(cand[1]);
    const score = Math.min(...avoid.map((a) => dist(a, rgb)));
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return { name: best[0], hex: best[1] };
}

// 팔레트 칩: 색마다 세로 2칸 [기본 / 그림자], 1번 색이 가장 넓게
function makeRampSwatch(ramps) {
  const cellH = 96;
  const widths = ramps.map((_, i) => (i === 0 ? 192 : 128));
  const W = widths.reduce((a, b) => a + b, 0);
  const png = new PNG({ width: W, height: cellH * 2 });
  let x0 = 0;
  ramps.forEach((ramp, i) => {
    const rows = [ramp.base, ramp.shadow].map(hexToRgb);
    for (let y = 0; y < cellH * 2; y++) {
      const [r, g, b] = rows[Math.floor(y / cellH)];
      for (let x = x0; x < x0 + widths[i]; x++) {
        const o = (y * W + x) * 4;
        png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
      }
    }
    x0 += widths[i];
  });
  return PNG.sync.write(png).toString("base64");
}

// ── 스타일 앵커 ──────────────────────────────────────────────────
// assets/sticker-anchor-*.png — ⚠️ 파일 하나에 객체 딱 하나. 여러 개가 들어간 시트는 넣지 마세요.
// 요청마다 그때 고른 키 컬러 위에 합성해서 "이 배경 위에 이런 거 하나"라는 결과 형태를 보여줍니다.
function flattenOnto(buffer, rgb) {
  const png = PNG.sync.read(buffer);
  const { data } = png;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    data[i] = Math.round(data[i] * a + rgb[0] * (1 - a));
    data[i + 1] = Math.round(data[i + 1] * a + rgb[1] * (1 - a));
    data[i + 2] = Math.round(data[i + 2] * a + rgb[2] * (1 - a));
    data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function loadStickerAnchors(keyHex) {
  try {
    const rgb = hexToRgb(keyHex);
    return fs
      .readdirSync(ASSETS_DIR)
      .filter((f) => /^sticker-anchor.*\.png$/i.test(f))
      .sort()
      .slice(0, 4)
      .map((f) => ({
        mimeType: "image/png",
        data: flattenOnto(fs.readFileSync(path.join(ASSETS_DIR, f)), rgb).toString("base64"),
      }));
  } catch {
    return [];
  }
}

// ── 프롬프트 ─────────────────────────────────────────────────────
// 단순화 단계별 "형태 예산" (플러그인 Simplify 슬라이더와 연동)
const SHAPE_BUDGET = [
  "Use about 6 to 9 large shapes.",
  "Use about 5 to 8 large shapes.",
  "Use about 4 to 7 large, chunky shapes.",
  "Use about 3 to 5 big, blobby shapes.",
];

const COLOR_BUDGET = [9, 7, 5, 4];

const ROLE = ["MAIN color — covers most of the object", "SECONDARY color", "ACCENT color — small parts only"];

function buildPrompt({ subject, extraDetail, ramps, key, anchorCount, simplify = 2, seenBackground }) {
  const paletteLines = ramps.map((r, i) =>
    `Color ${i + 1} (${colorName(r.base)}, ${ROLE[Math.min(i, 2)]}): ` +
    `base ${r.base}, shadow ${r.shadow}`
  );

  const lines = [
    `Draw exactly ONE single ${subject} as a flat, minimal vector illustration made only of solid color shapes.`,

    `ONE OBJECT ONLY (most important): the image contains a single ${subject} and nothing else.
Not a set, not a pair, not a group, not a pattern, no copies, no variations side by side,
no extra props or background objects. If the subject name could mean several items, draw just one.
The whole illustration is one connected silhouette.`,

    `NO LINES AT ALL: no outlines of any color (not dark, not colored, not white), no strokes, no rims drawn as lines, no contour lines, no dark edges, no line art,
no dividing lines between parts — not around the silhouette and not inside it.
Parts are separated only by flat color changes. No white border or sticker border
(it is added later). The shapes touch the background directly.`,

    `TWO TONES ONLY (very important): every part uses exactly two flat tones of its color — the BASE
tone, plus ONE shadow shape in the SHADOW tone on the side facing away from a single light at the TOP-LEFT
(lower-right side of round things, right face of boxy things). No third tone, no mid-tones, no gradients.
At most one small white highlight shape on the whole object (optional).`,

    `NO RIMS, BEVELS OR REFLECTIONS: do not draw inner rings, rim bands, edge highlights, bevels,
double borders, grooves, seams, reflections or glints. A lid is one flat shape, a mirror is one flat
light-gray shape, a round container is one shape plus its shadow.`,

    `COLOR BUDGET: the whole illustration uses at most ${Math.max(COLOR_BUDGET[simplify], ramps.length * 2 + 1)} distinct colors in total.`,

    `STYLE — CHUNKY, ROUND AND SOFT (most important after single object): ${SHAPE_BUDGET[simplify]}
Every corner and every tip is generously rounded, like a soft vinyl toy or a cute puffy sticker.
Chubby, compact proportions; thick parts; nothing thin, spiky or fiddly. No 3D rendering,
no photorealism, no drop shadow, no cast shadow on the ground.`,

    `NO SMALL MARKS: nothing scattered inside shapes — no individual grains, seeds, dots, specks,
crumbs, stitches, cracks, patterns, sparkles or tiny parts. Rice is ONE solid white shape (not grains),
cheese is one shape, a pizza has at most 3 big round toppings. If a material has a texture, suggest it
only with a few big, soft bumps on that part's edge (${simplify >= 3 ? "or leave it perfectly smooth" : "3 to 6 bumps at most"}).`,

    `SIMPLIFY THE DRAWING, NOT THE OBJECT (very important): keep every part that makes the subject
recognizable, and simplify how each part is drawn. A viewer must identify the subject instantly.
Examples: a lipstick keeps its colored bullet, the tube and the base; an open cushion compact keeps
the lid with its mirror, the base and the puff; sushi keeps the fish slice on top of the rice block;
a bubble tea keeps its pearls. Drop decoration, never the defining parts.`,

    `ALL PARTS CONNECTED: parts touch or overlap each other directly. Never leave background-colored
gaps or slits between parts. Mirrors, glass and glossy surfaces are painted in light gray or light
tints of the palette — never in the background color.`,

    `NO TEXT: never write letters, words, numbers, labels or the subject's name on the object, in any language.`,

    anchorCount
      ? `The ${anchorCount} attached style examples each show ONE illustration in exactly this style and
lighting logic (top-left light, flat tones, no lines). Match their shading direction, but use FEWER
tones and details than they do: two tones per part, no rims or bevels. Do NOT copy their subjects or colors, and draw only ONE ${subject}.`
      : null,

    ramps.length
      ? `COLOR PALETTE (strict): use ONLY these exact colors. Each color comes as a base + shadow pair;
each part of the object uses one pair.
${paletteLines.join(" | ")}
The attached swatch image shows these pairs (top row base, bottom row shadow).
No other hues. Small dark details (like eyes) may use the darkest shadow tone.`
      : `COLOR PALETTE: a small, harmonious palette of 2-3 cheerful colors, each used as base + shadow only.`,

    `BACKGROUND (critical for cut-out): a pure ${key.name} chroma-key screen, exactly ${key.hex},
like a video green screen — perfectly flat and saturated edge to edge. Do NOT tint, darken, desaturate
or shift the background toward the object's colors, no gradient, no vignette, no texture, no shadow,
no scene, no floor. Never use ${key.name} or anything close to it inside the illustration.
${seenBackground ? `(Last attempt the background came out as ${seenBackground}, which was wrong and too close to the object's colors — this time use exactly ${key.hex}.)` : ""}`,

    `COMPOSITION: the single ${subject} is centered, filling about 65% of the frame, with plenty of
background visible on all four sides. No text or lettering unless explicitly requested below.`,

    extraDetail ? `Additional detail: ${extraDetail}` : null,
  ];

  return lines
    .filter(Boolean)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n\n");
}

// ── 핸들러 ───────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST 요청만 허용됩니다." });
  }

  try {
    const { subject, extraDetail, colors: rawColors, referenceImageBase64, simplify: rawSimplify, avoidKey, seenBackground: rawSeen, objectColors: rawObj } = req.body || {};
    // 재시도 시 플러그인이 실제 물체에서 뽑은 색 — 키 컬러를 이것들과 멀리 고르는 데만 씀
    const objectColors = Array.isArray(rawObj) ? rawObj.filter((c) => typeof c === "string" && HEX_RE.test(c)).slice(0, 8) : [];
    const seenBackground = typeof rawSeen === "string" && HEX_RE.test(rawSeen) ? rawSeen.toUpperCase() : null;
    const simplify = [0, 1, 2, 3].includes(rawSimplify) ? rawSimplify : 2;

    if (!subject || typeof subject !== "string") {
      return res.status(400).json({ error: "subject(사물 이름, 예: 'cat')가 필요합니다." });
    }

    const colors = Array.isArray(rawColors)
      ? rawColors.filter((c) => typeof c === "string" && HEX_RE.test(c)).slice(0, MAX_COLORS)
      : [];
    const ramps = colors.map(makeRamp);
    const palette = ramps.flatMap((r) => [r.base, r.shadow]);

    const key = pickKeyColor(palette.concat(objectColors), typeof avoidKey === "string" ? avoidKey : null);
    const anchors = referenceImageBase64
      ? [{ mimeType: "image/png", data: referenceImageBase64 }]
      : loadStickerAnchors(key.hex);

    const parts = [
      { text: buildPrompt({ subject, extraDetail, ramps, key, anchorCount: anchors.length, simplify, seenBackground }) },
    ];

    // 앵커는 한 장씩 따로, "예시 n — 객체 하나" 라벨과 함께
    anchors.forEach((a, i) => {
      parts.push({ text: `Style example ${i + 1} of ${anchors.length} (one single illustration):` });
      parts.push({ inlineData: a });
    });
    if (ramps.length) {
      parts.push({ text: "Color swatch (columns = colors in order, top row = base, bottom row = shadow):" });
      parts.push({ inlineData: { mimeType: "image/png", data: makeRampSwatch(ramps) } });
    }

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: "1:1" },
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res.status(geminiRes.status).json({ error: "Gemini API 오류", detail: errText });
    }

    const data = await geminiRes.json();
    const responseParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = responseParts.find((p) => p.inlineData?.data);

    if (!imagePart) {
      return res.status(502).json({ error: "이미지 생성 결과가 없습니다.", raw: data });
    }

    return res.status(200).json({
      subject,
      colors,
      palette,          // 플러그인이 색 스냅에 씀 (색을 안 골랐으면 빈 배열 → 플러그인이 자동 추출)
      mimeType: imagePart.inlineData.mimeType,
      imageBase64: imagePart.inlineData.data,
      keyColor: key.hex,
    });
  } catch (err) {
    return res.status(500).json({ error: "서버 오류", detail: String(err) });
  }
};
