// The Edge Read-Aloud endpoint rejects WebSocket handshakes unless they carry
// Edge-browser headers (User-Agent, the read-aloud extension Origin, and a
// muid cookie). Browser WebSockets can't set those — this installs a
// declarativeNetRequest session rule that rewrites them at the network layer.

const RULE_ID = 7401;
const CHROMIUM_MAJOR = '143';
const EDGE_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)` +
  ` Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;

function randomMuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function ensureEdgeTtsHeaders() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  if (existing.some((r) => r.id === RULE_ID)) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'set', value: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold' },
            { header: 'User-Agent', operation: 'set', value: EDGE_UA },
            { header: 'Accept-Language', operation: 'set', value: 'en-US,en;q=0.9' },
            { header: 'Pragma', operation: 'set', value: 'no-cache' },
            { header: 'Cache-Control', operation: 'set', value: 'no-cache' },
            { header: 'Cookie', operation: 'set', value: `muid=${randomMuid()};` },
          ],
        },
        condition: {
          urlFilter: '||speech.platform.bing.com/consumer/speech/synthesize/readaloud/',
          resourceTypes: ['websocket'],
        },
      },
    ],
  });
}
