// Streams each window to the demo image's viewer (demo/viewer) with the Chrome DevTools screencast, when
// EXPLORE_SCREENCAST names the viewer's internal address (http://127.0.0.1:<port>). Frames are posted as JPEG; a lost
// frame is simply skipped.

const URL_ = process.env.EXPLORE_SCREENCAST || "";

function post(path, body) {
  return fetch(`${URL_}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .catch(() => {});
}

export async function screencast(who) {
  if (!URL_) return;
  const cdp = await who.context.newCDPSession(who.page);
  let busy = false;
  cdp.on("Page.screencastFrame", async (frame) => {
    cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    if (busy) return;
    busy = true;
    await post("/frame", { key: who.key, role: who.role, data: frame.data });
    busy = false;
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800 });
  post("/window", { key: who.key, role: who.role, open: true });
  const close = who.close;
  who.close = async () => {
    post("/window", { key: who.key, role: who.role, open: false });
    await close();
  };
}

export function caption(role, text) {
  if (URL_) post("/caption", { role, text });
}
