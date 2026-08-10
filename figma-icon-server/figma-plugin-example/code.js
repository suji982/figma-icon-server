// code.js (Figma 플러그인 메인 스레드)
//
// 전제조건: manifest.json 에 아래처럼 networkAccess 를 등록해야
// 플러그인이 외부 서버(Vercel)로 fetch 요청을 보낼 수 있습니다.
//
// manifest.json 예시:
// {
//   "networkAccess": {
//     "allowedDomains": ["https://YOUR-PROJECT.vercel.app"]
//   }
// }

const SERVER_ENDPOINT = "https://YOUR-PROJECT.vercel.app/api/generate-icon";

/**
 * subject: 아이콘 이름 (예: "camera")
 * extraDetail: 추가 디테일 지시문 (선택)
 *
 * 참조 이미지는 서버에 고정 저장된 style-anchor.png가 자동으로 적용되므로
 * 여기서는 신경 쓸 필요가 없습니다. (특정 요청만 다른 스타일로 하고 싶으면
 * referenceImageBase64를 세 번째 인자로 넘기면 그때만 서버 기본값을 덮어씁니다.)
 */
async function generateIcon(subject, extraDetail, referenceImageBase64) {
  const res = await fetch(SERVER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject, extraDetail, referenceImageBase64 }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `서버 오류 (${res.status})`);
  }

  return res.json(); // { subject, mimeType, imageBase64, backgroundColor }
}

function base64ToUint8Array(base64) {
  const binary = figma.base64Decode(base64);
  return binary;
}

async function insertIconOnCanvas(subject, extraDetail, referenceImageBase64) {
  figma.notify(`"${subject}" 아이콘 생성 중...`);

  const { imageBase64, backgroundColor } = await generateIcon(
    subject,
    extraDetail,
    referenceImageBase64
  );

  // 참고: 이 서버는 이미지를 backgroundColor(#FFFFFF 화이트) 배경으로 생성만 해줍니다.
  // 배경 제거는 이 예시에 포함하지 않았습니다 — remove.bg의 Figma 플러그인처럼,
  // 배경 제거 로직/API 호출을 이 플러그인 코드 안에 별도로 붙이는 걸 전제로 합니다.
  // (예: 여기서 imageBase64를 배경 제거 함수/API에 먼저 통과시킨 뒤, 그 결과로
  // figma.createImage()를 호출하면 됩니다.)

  const bytes = base64ToUint8Array(imageBase64);
  const image = figma.createImage(bytes);

  const rect = figma.createRectangle();
  rect.resize(256, 256);
  rect.name = subject;
  rect.fills = [
    {
      type: "IMAGE",
      imageHash: image.hash,
      scaleMode: "FILL",
    },
  ];

  figma.currentPage.appendChild(rect);
  figma.viewport.scrollAndZoomIntoView([rect]);
  figma.notify(`"${subject}" 아이콘 생성 완료`);

  return rect;
}

// UI(ui.html)에서 사용자가 이름을 입력하고 "생성" 버튼을 누르면
// 아래처럼 메시지를 받아서 처리합니다.
figma.ui.onmessage = async (msg) => {
  if (msg.type === "generate-icon") {
    try {
      await insertIconOnCanvas(
        msg.subject,
        msg.extraDetail,
        msg.referenceImageBase64
      );
    } catch (e) {
      figma.notify(`오류: ${e.message}`, { error: true });
    }
  }
};

figma.showUI(__html__, { width: 320, height: 240 });
