import { DeviceTestScreen } from "./device-test/DeviceTestScreen.js";
import { OperatorScreen } from "./operator/OperatorScreen.js";
import { ParticipantScreen } from "./participant/ParticipantScreen.js";

function NotFound(): React.JSX.Element {
  return (
    <main className="not-found">
      <p>404</p>
      <h1>画面が見つかりません</h1>
      <a href="/operator">実験進行コンソールへ</a>
    </main>
  );
}

export function App(): React.JSX.Element {
  const path = window.location.pathname;
  if (path === "/operator" || path === "/") return <OperatorScreen />;
  if (path === "/device-test") return <DeviceTestScreen />;
  const displayMatch = /^\/display\/([^/]+)$/u.exec(path);
  if (displayMatch?.[1] !== undefined) {
    let displayToken: string;
    try {
      displayToken = decodeURIComponent(displayMatch[1]);
    } catch {
      return <NotFound />;
    }
    return displayToken.length > 0 ? <ParticipantScreen displayToken={displayToken} /> : <NotFound />;
  }
  return <NotFound />;
}
